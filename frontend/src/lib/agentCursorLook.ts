import type { Point } from './agentCursorMotion';
import { contrastRatio } from './agentCursorColor';

/**
 * How an agent cursor reads (GM - Design, agent cursor §1 and §4): when its
 * name shows, where the say pill sits, the name's text colour, the fill for
 * each session of one agent, and how cursors keep off each other's tips.
 */

/** The person's pointer counts as over a cursor's arrow or pills within this many px (cursors take no pointer events). */
export const AGENT_CURSOR_HOVER_SLOP_PX = 4;
/** The name shows this long on a first sighting. */
export const AGENT_CURSOR_NAME_FIRST_SIGHT_MS = 1500;
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
/** A cursor whose target is within `radiusPx` of a column member's target
 *  (or whose shape at its target meets a placed cursor) joins that column,
 *  straight below it, never to the right. Its arrow's painted top sits
 *  `gapPx` under the earlier label block; `clearPx` is the least painted
 *  gap between any two cursors (GM - Design, PR #211 r14 and review 6;
 *  stackStepPx, deStackLayout). Joins and steps are screen px, at any zoom.
 *  The target chain (targetChains; the backend's agent_presence.ARRIVAL_RADIUS)
 *  and the column insert's comparison use the same 16 in canvas units, so
 *  they agree at any zoom (#219 r62). The chain decides arrival only, never
 *  joining: joins stay this tab's, by screen px (GM - Design, #219 r24 Q2). */
export const AGENT_CURSOR_STACK = { radiusPx: 16, clearPx: 2, gapPx: 4 } as const;
export const AGENT_CURSOR_INK_DARK = '#0b0b0c';
export const AGENT_CURSOR_INK_LIGHT = '#ffffff';
// The cursor's label (its name and number) lives in agentCursorLabel, so the
// Agent log can name a cursor exactly as its pill does without this module.
export { AGENT_CURSOR_TITLE_CHARS, cursorLabel, cutGraphemes, sessionName } from './agentCursorLabel';
// The session shades and contrast maths live in agentCursorColor, which the
// Agent log uses too (GM - Design, PR #211 r20).
export {
  AGENT_CURSOR_SESSION_BAND,
  AGENT_CURSOR_SESSION_LIGHTNESS,
  contrastRatio,
  hexToOklch,
  luminance,
  readableTone,
  sessionFill,
  sessionLightness,
} from './agentCursorColor';

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
  /** When this cursor came to its spot: earlier ones keep their place (GM - Design, PR #211 r2),
   *  in the backend's arrival order (r21). */
  since: number;
  /** Ties in `since` are broken by this (the tab's own landing order). */
  seq?: number;
  /** Its say pill shows (or is fading out): its label block is name plus say. */
  say?: boolean;
  /** Its pills' widths in screen px (labelWidths); a default when unknown. */
  nameW?: number;
  sayW?: number;
}

/** Pill widths assumed when a caller doesn't know them. */
const DEFAULT_NAME_W = 4 * AGENT_CURSOR_PILL.height;
const DEFAULT_SAY_W = 8 * AGENT_CURSOR_PILL.height;

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
  const len = dx * dx + dy * dy;
  const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len));
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

function cross(o: Point, a: Point, b: Point): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

/** Distance between segments a-b and c-d: 0 when they cross. */
function segmentToSegment(a: Point, b: Point, c: Point, d: Point): number {
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return 0;
  return Math.min(pointToSegment(a, c, d), pointToSegment(b, c, d), pointToSegment(c, a, b), pointToSegment(d, a, b));
}

function boxToBox(a: Box, b: Box): number {
  return Math.hypot(Math.max(0, a.left - b.right, b.left - a.right), Math.max(0, a.top - b.bottom, b.top - a.bottom));
}

/** A painted pill: its core segment's box (the pill less its round ends'
 *  radius) and that radius, edge ring included. */
interface Pill { core: Box; radius: number }

function pill(top: number, ring: number, dy = 0, width = DEFAULT_NAME_W, dx = 0): Pill {
  const { left, height } = AGENT_CURSOR_PILL;
  const r = height / 2;
  const w = Math.max(width, height);
  return { core: { left: left + r + dx, right: left + w - r + dx, top: top + r + dy, bottom: top + r + dy }, radius: r + ring };
}

/** The earlier cursor's painted label block: its name pill (edge ring
 *  included) and, while one shows, its say pill. */
export function labelBlockPills(say: boolean): Pill[] {
  const { top, height, gap, ring } = AGENT_CURSOR_PILL;
  return say ? [pill(top, ring), pill(top + height + gap, 0, 0, DEFAULT_SAY_W)] : [pill(top, ring)];
}

/** The bottom of a cursor's painted label block below its origin, in screen
 *  px: the name pill's ring, or the say pill under it. */
export function labelBlockBottomPx(say: boolean): number {
  const { top, height, gap, ring } = AGENT_CURSOR_PILL;
  return say ? Math.max(top + height + ring, top + 2 * height + gap) : top + height + ring;
}

/** The top of the arrow's painted path below the cursor's origin (stroke included). */
export const AGENT_CURSOR_ARROW_TOP = Math.min(...AGENT_CURSOR_ARROW_POINTS.map((p) => p.y)) - AGENT_CURSOR_ARROW_STROKE / 2;

/**
 * How far apart, in screen px, a later cursor `dy` px straight below an
 * earlier one paints from the earlier one's label block: its arrow's
 * painted path (stroke included) and its own name pill (edge ring
 * included) against the earlier name pill (ring included) and say pill.
 * Negative when they overlap. The floor under stackStepPx.
 */
export function stackClearancePx(dy: number, earlierSay: boolean): number {
  return cursorClearancePx(cursorShape({ x: 0, y: 0 }, earlierSay), cursorShape({ x: 0, y: dy }, false));
}

/** A cursor as painted, in screen px: its arrow's corners (the path at the
 *  tip, stroke not included) and its pills. */
export interface CursorShape {
  arrow: Point[];
  pills: Pill[];
  /** Arrow and pills. */
  bounds: Box;
  /** The arrow's painted box. */
  arrowBox: Box;
  /** What the cursor owns: from its arrow's top to gapPx under its label
   *  block, across arrow and pills. Another arrow in here reads as this
   *  label's owner (GM - Design, PR #211 r14). */
  unit: Box;
  /** A say pill on the left of the arrow owns its own box and gapPx under
   *  it; `unit` then covers the arrow, the name and the say row to their
   *  right only (r17 item 2). */
  sayUnit?: Box;
}

/** Where a say pill flipped to the left of its arrow ends: its right edge
 *  this far left of the tip (GM - Design, PR #211 r17 item 2). */
export const AGENT_CURSOR_SAY_LEFT_GAP_PX = 4;

/** The tip of the arrow below the cursor's origin. */
const TIP = AGENT_CURSOR_ARROW_POINTS[0];

/**
 * A cursor as painted at `origin` (screen px). `say` draws its say pill:
 * true or 'right' under the name, as always; 'left' on the same row with
 * its right edge AGENT_CURSOR_SAY_LEFT_GAP_PX left of the tip, where a say
 * goes when its right side would touch another column (r17 item 2).
 */
export function cursorShape(origin: Point, say: boolean | 'right' | 'left', nameW = DEFAULT_NAME_W, sayW = DEFAULT_SAY_W): CursorShape {
  const { top, height, gap, ring, left } = AGENT_CURSOR_PILL;
  const arrow = AGENT_CURSOR_ARROW_POINTS.map((p) => ({ x: p.x + origin.x, y: p.y + origin.y }));
  const pills = [pill(top, ring, origin.y, nameW, origin.x)];
  const sayLeft = say === 'left';
  const sayWidth = Math.max(sayW, height);
  // The left say's own left edge, from the origin.
  const leftSayAt = TIP.x - AGENT_CURSOR_SAY_LEFT_GAP_PX - sayWidth;
  if (say) pills.push(pill(top + height + gap, 0, origin.y, sayW, origin.x + (sayLeft ? leftSayAt - left : 0)));
  const half = AGENT_CURSOR_ARROW_STROKE / 2;
  const arrowLeft = origin.x + Math.min(...AGENT_CURSOR_ARROW_POINTS.map((p) => p.x)) - half;
  const bounds = {
    left: Math.min(arrowLeft, sayLeft ? origin.x + leftSayAt : Infinity),
    right: origin.x + Math.max(Math.max(...AGENT_CURSOR_ARROW_POINTS.map((p) => p.x)) + half, left + Math.max(nameW, height) + ring, say && !sayLeft ? left + sayWidth : 0),
    top: origin.y + AGENT_CURSOR_ARROW_TOP,
    bottom: origin.y + labelBlockBottomPx(Boolean(say)),
  };
  const arrowBox = {
    left: origin.x + Math.min(...AGENT_CURSOR_ARROW_POINTS.map((p) => p.x)) - half,
    right: origin.x + Math.max(...AGENT_CURSOR_ARROW_POINTS.map((p) => p.x)) + half,
    top: bounds.top,
    bottom: origin.y + Math.max(...AGENT_CURSOR_ARROW_POINTS.map((p) => p.y)) + half,
  };
  const g = AGENT_CURSOR_STACK.gapPx;
  if (!sayLeft) return { arrow, pills, bounds, arrowBox, unit: { ...bounds, bottom: bounds.bottom + g } };
  const sayBox = sayPillBox({ pills } as CursorShape)!;
  return {
    arrow, pills, bounds, arrowBox,
    unit: { ...bounds, left: arrowLeft, bottom: origin.y + labelBlockBottomPx(false) + g },
    sayUnit: { ...sayBox, bottom: sayBox.bottom + g },
  };
}

/** The say pill's painted box in a shape that has one (its last pill). */
export function sayPillBox(shape: CursorShape): { left: number; top: number; right: number; bottom: number } | null {
  if (shape.pills.length < 2) return null;
  const { core, radius } = shape.pills[shape.pills.length - 1];
  return { left: core.left - radius, right: core.right + radius, top: core.top - radius, bottom: core.bottom + radius };
}

/** Do two cursors meet: painted closer than clearPx, or either's arrow
 *  inside what the other owns (beside its label)? */
export function cursorsMeet(a: CursorShape, b: CursorShape): boolean {
  const inside = (box: Box, unit: Box | undefined) => unit !== undefined
    && box.left < unit.right && box.right > unit.left && box.top < unit.bottom && box.bottom > unit.top;
  return inside(a.arrowBox, b.unit) || inside(b.arrowBox, a.unit) || inside(a.arrowBox, b.sayUnit) || inside(b.arrowBox, a.sayUnit)
    || cursorClearancePx(a, b) < AGENT_CURSOR_STACK.clearPx - 1e-9;
}

/**
 * The painted gap between two cursors, in screen px: every arrow against
 * the other arrow (both strokes) and the other's pills, and pill against
 * pill. Negative when they overlap.
 */
export function cursorClearancePx(a: CursorShape, b: CursorShape): number {
  const far = boxToBox(a.bounds, b.bounds);
  if (far > AGENT_CURSOR_STACK.clearPx + 1) return far;
  const half = AGENT_CURSOR_ARROW_STROKE / 2;
  let clear = Infinity;
  const n = AGENT_CURSOR_ARROW_POINTS.length;
  for (let i = 0; i < n; i += 1) {
    const a0 = a.arrow[i];
    const a1 = a.arrow[(i + 1) % n];
    for (let j = 0; j < n; j += 1) clear = Math.min(clear, segmentToSegment(a0, a1, b.arrow[j], b.arrow[(j + 1) % n]) - 2 * half);
    for (const p of b.pills) clear = Math.min(clear, segmentToBox(a0, a1, p.core) - p.radius - half);
    const b0 = b.arrow[i];
    const b1 = b.arrow[(i + 1) % n];
    for (const p of a.pills) clear = Math.min(clear, segmentToBox(b0, b1, p.core) - p.radius - half);
  }
  for (const p of a.pills) for (const q of b.pills) clear = Math.min(clear, boxToBox(p.core, q.core) - p.radius - q.radius);
  return clear;
}

const stepCache = new Map<boolean, number>();

/**
 * The step down, in whole screen px, from an earlier cursor to the one
 * stacked below it (GM - Design, PR #211 r14): the later arrow's painted
 * top sits AGENT_CURSOR_STACK.gapPx below the bottom of the earlier
 * cursor's whole label block (name pill and ring, plus the say pill while
 * one shows), so each arrow sits by its own label only. 42 below a name;
 * 65 below a name and a say. The painted check (clearPx between arrow,
 * pills and the earlier block) is the floor. The step is rounded up to
 * whole px so the pills stay on the pixel grid; with the arrow's painted
 * top at 0.8 px that leaves 4.8 px under a ringed name pill and 5.8 px
 * under a say pill (no ring), never under 4 (review 7 NIT-2).
 */
export function stackStepPx(earlierSay: boolean): number {
  const cached = stepCache.get(earlierSay);
  if (cached !== undefined) return cached;
  let floor = 0;
  while (stackClearancePx(floor, earlierSay) < AGENT_CURSOR_STACK.clearPx - 1e-9) floor += 1;
  const owned = Math.ceil(labelBlockBottomPx(earlierSay) + AGENT_CURSOR_STACK.gapPx - AGENT_CURSOR_ARROW_TOP - 1e-9);
  const dy = Math.max(floor, owned);
  stepCache.set(earlierSay, dy);
  return dy;
}

/** Where a cursor lands, and what put it there: `sig` names the column
 *  members it is stacked under (with their says), so a change in it is a
 *  change of layout (a say, a join, a leave), and anything else moving the
 *  spot is a ride (a node carried, a zoom). `above` lists those members.
 *  `column` is the column's id: its earliest arrival's key (not always the
 *  top cursor: a later one aimed higher goes in above it, r24 Q1). In a
 *  column of four or more, the third slot stands for the rest: its cursor's
 *  spot carries `group` (itself and the later arrivals folded into it, in
 *  arrival order), and each folded cursor's carries `collapsedInto`, that
 *  slot's key (GM - Design, PR #211 r17 item 1, r21). */
export interface StackSpot {
  at: Point;
  sig: string;
  above: readonly string[];
  column?: string;
  group?: readonly string[];
  collapsedInto?: string;
}

/**
 * Each cursor's target chain: the other cursors linked to it through
 * targets AGENT_CURSOR_STACK.radiusPx apart or less, one link after another,
 * from targets alone, in canvas units at zoom 1 (GM - Design, #219 r24 Q2).
 * The backend's own (agent_presence._target_chains) decides when a carry is
 * an arrival; this one only previews it while a node is dragged (r47 Q1).
 * Both run the shared fixture (backend/tests/fixtures/cursor_chains.json),
 * so they can't drift. It decides no join: joins are deStackLayout's.
 */
export function targetChains(points: ReadonlyMap<string, Point>): Map<string, ReadonlySet<string>> {
  const keys = [...points.keys()];
  const parent = new Map(keys.map((k) => [k, k]));
  const find = (k: string): string => {
    while (parent.get(k) !== k) {
      const up = parent.get(parent.get(k)!)!;
      parent.set(k, up);
      k = up;
    }
    return k;
  };
  for (let i = 0; i < keys.length; i += 1) {
    const a = points.get(keys[i])!;
    for (let j = i + 1; j < keys.length; j += 1) {
      const b = points.get(keys[j])!;
      if (Math.hypot(a.x - b.x, a.y - b.y) <= AGENT_CURSOR_STACK.radiusPx + 1e-9) parent.set(find(keys[i]), find(keys[j]));
    }
  }
  const groups = new Map<string, string[]>();
  for (const k of keys) {
    const r = find(k);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r)!.push(k);
  }
  return new Map(keys.map((k) => [k, new Set(groups.get(find(k))!.filter((o) => o !== k))]));
}

/** Whether two chains hold the same cursors. */
export function sameChain(a: ReadonlySet<string> | undefined, b: ReadonlySet<string> | undefined): boolean {
  if (!a || !b) return a === b;
  if (a.size !== b.size) return false;
  for (const k of a) if (!b.has(k)) return false;
  return true;
}

/** A column draws at most this many cursors: from the next member on, the
 *  last slot is one count cursor ("2 more") for all of them (r17 item 1). */
export const AGENT_CURSOR_COLUMN_DRAWN = 3;

/** The count cursor's pill: how many cursors its slot stands for. */
export function countLabel(count: number): string {
  return `${count} more`;
}

/**
 * Where each cursor lands so no arrow sits beside or over a name or arrow
 * that isn't its own (GM - Design, PR #211 r14, review 6, r17 and r21).
 *
 * First every join is resolved: a cursor joins another's column when its
 * target is within 16 screen px of that cursor's target, or when its arrow
 * and name at its own target come within clearPx of an earlier cursor's
 * arrow or name where that one is drawn; and two columns join when any of
 * their drawn cursors meet. A say pill never makes a join (r17 item 2).
 * Joins are transitive, and resolved again until no drawn cursor meets
 * another column, so near and identical targets make one column.
 *
 * Then each final column is laid out at its earliest arrival's x. With
 * more than AGENT_CURSOR_COLUMN_DRAWN members, the two earliest arrivals
 * are drawn in full and the third arrival is the count cursor, exactly one
 * step under the last full cursor, standing for every later arrival
 * (StackSpot.group). The full cursors go down the column in a stable
 * insert, in arrival order: each just before the first one placed that
 * aims more than radiusPx canvas units below it, else last (GM - Design,
 * #219 r24 Q1; canvas units, like the target chain, r62).
 * The top one sits on its own target; each next one at the lower of a
 * stackStepPx under the one above (its label block, say included) and its
 * own target, so it is never above its target (r23 item 1) nor more than
 * 2 steps + 2 radii below it. A cursor that changes slot when
 * columns merge or split glides there on the layout spring (its `sig`
 * changes). Only live cursors are passed in: a leaving one doesn't count.
 * Arrival is `since`, then `seq`, then the key. Targets and results are in
 * flow coordinates; joins and steps are in screen px at `zoom`, the
 * insert's comparison in canvas units (r62).
 */
export function deStackLayout(cursors: readonly StackEntry[], zoom: number): Map<string, StackSpot> {
  const { radiusPx } = AGENT_CURSOR_STACK;
  const ordered = [...cursors].sort((a, b) => a.since - b.since || (a.seq ?? 0) - (b.seq ?? 0)
    || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const n = ordered.length;
  const targets = ordered.map((c) => ({ x: c.target.x * zoom, y: c.target.y * zoom }));
  const nameW = ordered.map((c) => c.nameW ?? DEFAULT_NAME_W);
  const says = ordered.map((c) => Boolean(c.say));
  // Arrow and name only: a say pill never makes a join (r17 item 2).
  const own = targets.map((t, i) => cursorShape(t, false, nameW[i]));
  const parent = ordered.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]];
    return i;
  };
  const union = (i: number, j: number): boolean => {
    const a = find(i);
    const b = find(j);
    if (a === b) return false;
    // The root is the earlier arrival: it is the column's head.
    if (a < b) parent[b] = a;
    else parent[a] = b;
    return true;
  };
  interface Laid { tip: Point; shape: CursorShape | null; sig: string; above: string[]; slot: number | null; group: number[] | null; column: number }
  // The first `count` arrivals, laid out in their columns.
  const lay = (count: number): Laid[] => {
    const out: Laid[] = new Array(count);
    const columns = new Map<number, number[]>();
    for (let i = 0; i < count; i += 1) {
      const r = find(i);
      if (!columns.has(r)) columns.set(r, []);
      columns.get(r)!.push(i); // in arrival order: i ascends
    }
    for (const [head, members] of columns) {
      const full = members.length > AGENT_CURSOR_COLUMN_DRAWN;
      // Drawn in full: every member, or with more than the column draws,
      // the two earliest arrivals (folding is by latest arrival), then the
      // count cursor, the third arrival, standing for the rest.
      const shown = full ? members.slice(0, AGENT_CURSOR_COLUMN_DRAWN - 1) : members;
      // Their order down the column: a stable insert in arrival order. Each
      // goes in just before the first member already placed whose target is
      // more than radiusPx canvas units below its own, else last; those
      // placed keep their order. So every member above one aims at most
      // radiusPx canvas units (radiusPx * zoom screen px) lower than it, and
      // no full cursor is drawn more than 2 steps + 2 radii below its own
      // target. Cursors aimed near one point keep arrival order (GM - Design,
      // #219 r24 Q1). Canvas units, as the target chain is, so the insert and
      // the chain agree at any zoom (r62); the steps stay screen px.
      const order: number[] = [];
      for (const m of shown) {
        const at = order.findIndex((o) => ordered[o].target.y > ordered[m].target.y + radiusPx + 1e-9);
        if (at === -1) order.push(m);
        else order.splice(at, 0, m);
      }
      const x = targets[head].x;
      let prev: number | null = null;
      const place = (m: number, tip: Point) => {
        out[m] = {
          tip,
          shape: cursorShape(tip, false, nameW[m]),
          sig: prev === null ? '' : `${out[prev].sig || ordered[head].key}>${ordered[prev].key}${says[prev] ? '+' : ''}`,
          above: prev === null ? [] : [...out[prev].above, ordered[prev].key],
          slot: null,
          group: null,
          column: head,
        };
        prev = m;
      };
      for (const m of order) {
        // A step under the one before, never above its own target: a member
        // whose slot would sit above the point it aims at is drawn at that
        // point instead, and the slots under it shift down (a gap is fine).
        // GM - Design, #211 follow-up r23 item 1.
        place(m, prev === null ? { x, y: targets[m].y } : { x, y: Math.max(out[prev].tip.y + stackStepPx(says[prev]), targets[m].y) });
      }
      if (full) {
        // The count: exactly one step under the last full cursor, no gap.
        const slot = members[AGENT_CURSOR_COLUMN_DRAWN - 1];
        const last: number = prev!;
        place(slot, { x, y: out[last].tip.y + stackStepPx(says[last]) });
        out[slot].group = members.slice(AGENT_CURSOR_COLUMN_DRAWN - 1);
        for (const m of members.slice(AGENT_CURSOR_COLUMN_DRAWN)) {
          out[m] = {
            tip: out[slot].tip, shape: null, sig: `${out[slot].sig}#${ordered[slot].key}`,
            above: out[slot].above, slot, group: null, column: head,
          };
        }
      }
    }
    return out;
  };
  // Joins, resolved in arrival order as each cursor comes (the earlier ones
  // laid out as they are then): its target near an earlier one's, or its
  // arrow and name at its target meeting an earlier one where it is drawn.
  // Then, while any drawn cursor meets another column, those columns join.
  // The first check's meeting is not redundant with the loop since members
  // keep to their own targets (r23 item 1): without it, 739 of 50,000
  // random sets lay out differently (#211 review 9, NIT-1, checked).
  let laid: Laid[] = [];
  for (let i = 0; i < n; i += 1) {
    const before = lay(i);
    for (let j = 0; j < i; j += 1) {
      const near = Math.hypot(targets[i].x - targets[j].x, targets[i].y - targets[j].y) <= radiusPx + 1e-9;
      const sj = before[j].shape; // null when folded: drawn as its slot
      if (near || (sj && cursorsMeet(own[i], sj))) union(i, j);
    }
    laid = lay(i + 1);
    for (let round = 0; round <= i + 1; round += 1) {
      let joined = false;
      for (let a = 0; a <= i; a += 1) {
        for (let c = a + 1; c <= i; c += 1) {
          const sa = laid[a].shape;
          const sc = laid[c].shape;
          if (sa && sc && find(a) !== find(c) && cursorsMeet(sa, sc)) joined = union(a, c) || joined;
        }
      }
      if (!joined) break;
      laid = lay(i + 1);
    }
  }
  const result = new Map<string, StackSpot>();
  for (let i = 0; i < n; i += 1) {
    const p = laid[i];
    const spot: StackSpot = { at: { x: p.tip.x / zoom, y: p.tip.y / zoom }, sig: p.sig, above: p.above, column: ordered[p.column].key };
    if (p.group) spot.group = p.group.map((k) => ordered[k].key);
    if (p.slot !== null) spot.collapsedInto = ordered[p.slot].key;
    result.set(ordered[i].key, spot);
  }
  return result;
}

/** Would these two cursors, each on its own target, join one column: the
 *  targets within the join radius, or the arrows and names meeting
 *  (deStackLayout; a say pill never joins)? */
export function targetsMeet(a: StackEntry, b: StackEntry, zoom: number): boolean {
  const ta = { x: a.target.x * zoom, y: a.target.y * zoom };
  const tb = { x: b.target.x * zoom, y: b.target.y * zoom };
  if (Math.hypot(ta.x - tb.x, ta.y - tb.y) <= AGENT_CURSOR_STACK.radiusPx + 1e-9) return true;
  return cursorsMeet(cursorShape(ta, false, a.nameW), cursorShape(tb, false, b.nameW));
}

/** Each cursor's spot (deStackLayout), in flow coordinates. */
export function deStack(cursors: readonly StackEntry[], zoom: number): Map<string, Point> {
  return new Map([...deStackLayout(cursors, zoom)].map(([key, spot]) => [key, spot.at]));
}

/** Text widths for the pills, without a layout read: the canvas's text
 *  metrics where there is one, else an estimate on the wide side. The
 *  canvas measures with the page's fonts as loaded now: a web font subset
 *  still loading measures as the fallback, so the layer measures again when
 *  fonts finish loading (AgentCursorLayer, review 7 MEDIUM-4). One context,
 *  made again only if the platform's OffscreenCanvas itself changes. */
let textContext: { font: string; measureText(text: string): { width: number } } | null = null;
let textContextFrom: unknown = null;
function textWidthPx(text: string, weight: number): number {
  const Canvas = typeof OffscreenCanvas !== 'undefined' ? OffscreenCanvas : null;
  if (Canvas !== textContextFrom) {
    textContextFrom = Canvas;
    try {
      textContext = Canvas ? (new Canvas(1, 1).getContext('2d') as unknown as typeof textContext) ?? null : null;
    } catch {
      textContext = null;
    }
  }
  if (!textContext) return text.length * 7;
  textContext.font = `${weight} 11px Inter, "Helvetica Neue", Helvetica, Arial, sans-serif`;
  // letter-spacing 0.01em on the name.
  return textContext.measureText(text).width + 0.11 * text.length;
}

/** The fonts the pills draw in, as `document.fonts.load` takes them. */
export const AGENT_CURSOR_NAME_FONT = '600 11px Inter';
export const AGENT_CURSOR_SAY_FONT = '500 11px Inter';

/** The name and say pills' widths in screen px (agentCursor.css: 7 px and
 *  9 px of padding, the say pill at most 260 px), 2 px on the wide side. */
export function labelWidths(name: string, say: string | null | undefined): { nameW: number; sayW: number } {
  return {
    nameW: Math.ceil(textWidthPx(name, 600) + 14 + 2),
    sayW: say ? Math.min(260, Math.ceil(textWidthPx(say, 500) + 18 + 2)) : 0,
  };
}

/** Keys in paint order: the most recently active cursor last, so it's on top. */
export function paintOrder(cursors: readonly { key: string; receivedAt: number }[]): string[] {
  return [...cursors]
    .sort((a, b) => a.receivedAt - b.receivedAt || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((c) => c.key);
}
