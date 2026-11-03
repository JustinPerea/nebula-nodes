import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  AGENT_CURSOR_INK_BLACK,
  AGENT_CURSOR_INK_DARK,
  AGENT_CURSOR_INK_LIGHT,
  AGENT_CURSOR_NAME_FIRST_SIGHT_MS,
  AGENT_CURSOR_SESSION_BAND,
  AGENT_CURSOR_SESSION_LIGHTNESS,
  sessionLightness,
  contrastRatio,
  deStack,
  deStackLayout,
  labelWidths,
  stackClearancePx,
  stackStepPx,
  hexToOklch,
  inkFor,
  labelLayout,
  nameVisible,
  paintOrder,
  sessionFill,
  sessionName,
  AGENT_CURSOR_PILL,
  AGENT_CURSOR_PILL_EDGE,
  AGENT_CURSOR_STACK,
  AGENT_CURSOR_ARROW_PATH,
  AGENT_CURSOR_ARROW_POINTS,
  AGENT_CURSOR_ARROW_STROKE,
  AGENT_CURSOR_COLUMN_DRAWN,
  AGENT_CURSOR_NAME_FONT,
  AGENT_CURSOR_SAY_FONT,
  AGENT_CURSOR_SAY_LEFT_GAP_PX,
  countLabel,
  cursorShape,
  cursorsMeet,
  sayPillBox,
  targetsMeet,
  pillEdge,
  targetChains,
  sameChain,
  type StackSpot,
} from '../src/lib/agentCursorLook';
import { nodeHeaderPoint } from '../src/lib/agentCursorMotion';

/** GM - Design's agent cursor spec, §1 (the name's ink) and §4 (names, say, several agents). */

// The runners' colours and the palette unverified agents hash into (backend services/agent_presence.py).
const CLAUDE = '#E8825A';
const CODEX = '#5B9DFF';
const PALETTE = ['#3FC1A5', '#F2C14E', '#FF6B9A', '#7AD3FF', '#C3E86B', '#FF9F43'];
const BUILT_IN = [CLAUDE, CODEX, ...PALETTE];

/**
 * GM r24's property for every final column of a layout (#219 Q1), from the
 * drawn spots alone:
 * - the column's id is its earliest arrival, and every member is drawn at
 *   its x;
 * - at most AGENT_CURSOR_COLUMN_DRAWN slots: with more members, the two
 *   earliest arrivals are full, the third is the count cursor standing for
 *   every later arrival, and the rest fold into it;
 * - the full cursors go down the column in the stable-insert order
 *   (insertOrder), the top one on its own target, each next exactly at
 *   max(the one above + its real step, its own target) (review 1, LOW-3:
 *   "at its target" and "a step under it" differ);
 * - so none is above its own target or more than 2 steps + 32 px below it,
 *   measured from the real tips and steps;
 * - the count sits exactly one step under the last full cursor.
 * Returns the worst offset below a target (screen px) for the fuzz stats.
 */
type Listed = { key: string; target: { x: number; y: number }; since: number; say?: boolean; nameW?: number };

/** The column order GM r24 sets: each, in arrival order, goes in just
 *  before the first placed member aimed more than 16 screen px below it. */
function insertOrder(members: readonly Listed[], zoom: number): Listed[] {
  const order: Listed[] = [];
  for (const m of members) {
    const at = order.findIndex((o) => (o.target.y - m.target.y) * zoom > AGENT_CURSOR_STACK.radiusPx + 1e-9);
    if (at === -1) order.push(m);
    else order.splice(at, 0, m);
  }
  return order;
}

const fuzzStats = { cursors: 0, worstBelowPx: 0, worstBoundUsedPx: 0, atTarget: 0, counts: 0 };

function expectColumnsCapped(list: readonly Listed[], laid: Map<string, StackSpot>, zoom = 1) {
  const columns = new Map<string, Listed[]>();
  for (const e of list) {
    const id = laid.get(e.key)!.column!;
    expect(id).toBeDefined();
    if (!columns.has(id)) columns.set(id, []);
    columns.get(id)!.push(e);
  }
  const step = (m: Listed) => stackStepPx(Boolean(m.say));
  for (const [id, members] of columns) {
    members.sort((a, b) => a.since - b.since || (a.key < b.key ? -1 : 1));
    expect(id).toBe(members[0].key);
    const x = members[0].target.x;
    const folds = members.length > AGENT_CURSOR_COLUMN_DRAWN;
    const full = folds ? members.slice(0, AGENT_CURSOR_COLUMN_DRAWN - 1) : members;
    const order = insertOrder(full, zoom);
    let prevTip: number | null = null;
    let prev: Listed | null = null;
    let stepsAbove = 0;
    for (const m of order) {
      const spot = laid.get(m.key)!;
      expect(spot.collapsedInto).toBeUndefined();
      expect(spot.group).toBeUndefined();
      expect(spot.at.x).toBe(x);
      // Screen px from here on.
      const tip = spot.at.y * zoom;
      const own = m.target.y * zoom;
      const expected = prevTip === null ? own : Math.max(prevTip + step(prev!), own);
      expect(Math.abs(tip - expected)).toBeLessThanOrEqual(1e-6);
      expect(tip).toBeGreaterThanOrEqual(own - 1e-6);
      const below = tip - own;
      expect(below).toBeLessThanOrEqual(stepsAbove + 2 * AGENT_CURSOR_STACK.radiusPx + 1e-6);
      fuzzStats.cursors += 1;
      if (below < 1e-6) fuzzStats.atTarget += 1;
      fuzzStats.worstBelowPx = Math.max(fuzzStats.worstBelowPx, below);
      fuzzStats.worstBoundUsedPx = Math.max(fuzzStats.worstBoundUsedPx, below - stepsAbove);
      stepsAbove += step(m);
      prevTip = tip;
      prev = m;
    }
    if (folds) {
      const slot = members[AGENT_CURSOR_COLUMN_DRAWN - 1];
      const spot = laid.get(slot.key)!;
      expect(spot.collapsedInto).toBeUndefined();
      expect(spot.at.x).toBe(x);
      expect(Math.abs(spot.at.y * zoom - (prevTip! + step(prev!)))).toBeLessThanOrEqual(1e-6);
      expect(spot.group).toEqual(members.slice(AGENT_CURSOR_COLUMN_DRAWN - 1).map((m) => m.key));
      for (const m of members.slice(AGENT_CURSOR_COLUMN_DRAWN)) expect(laid.get(m.key)!.collapsedInto).toBe(slot.key);
      fuzzStats.counts += 1;
    }
  }
  return columns;
}

/**
 * Review 9, LOW-4: no column is bigger than its joins make it. A cursor is
 * drawn somewhere from its own target down to where it ends up (a column
 * growing down pushes it one slot at a time), so its reach is the box its
 * arrow and name own over that sweep. Two cursors are linked when their
 * targets are within radiusPx or their reaches touch (clearPx). In each
 * column the links over its members connect them all, and a cursor linked
 * to no other cursor is a column of one. Screen px at `zoom`.
 */
function expectColumnsJustified(list: readonly Listed[], laid: Map<string, StackSpot>, zoom: number) {
  const { radiusPx, clearPx } = AGENT_CURSOR_STACK;
  const screen = (p: { x: number; y: number }) => ({ x: p.x * zoom, y: p.y * zoom });
  const reach = new Map(list.map((e) => {
    const from = cursorShape(screen(e.target), false, e.nameW);
    const to = cursorShape(screen(laid.get(e.key)!.at), false, e.nameW);
    return [e.key, {
      left: Math.min(from.bounds.left, from.unit.left, to.bounds.left, to.unit.left),
      right: Math.max(from.bounds.right, from.unit.right, to.bounds.right, to.unit.right),
      top: Math.min(from.bounds.top, from.unit.top, to.bounds.top, to.unit.top),
      bottom: Math.max(from.bounds.bottom, from.unit.bottom, to.bounds.bottom, to.unit.bottom),
    }];
  }));
  const linked = (a: Listed, b: Listed) => {
    const ta = screen(a.target);
    const tb = screen(b.target);
    if (Math.hypot(ta.x - tb.x, ta.y - tb.y) <= radiusPx + 1e-9) return true;
    const ra = reach.get(a.key)!;
    const rb = reach.get(b.key)!;
    return ra.left < rb.right + clearPx && rb.left < ra.right + clearPx && ra.top < rb.bottom + clearPx && rb.top < ra.bottom + clearPx;
  };
  const columns = new Map<string, Listed[]>();
  for (const e of list) {
    const id = laid.get(e.key)!.column!;
    if (!columns.has(id)) columns.set(id, []);
    columns.get(id)!.push(e);
  }
  for (const members of columns.values()) {
    const seen = new Set([members[0].key]);
    const queue = [members[0]];
    while (queue.length) {
      const a = queue.pop()!;
      for (const b of members) if (!seen.has(b.key) && linked(a, b)) { seen.add(b.key); queue.push(b); }
    }
    expect(seen.size).toBe(members.length);
  }
  for (const e of list) {
    if (list.every((o) => o.key === e.key || !linked(e, o))) expect(columns.get(laid.get(e.key)!.column!)!.length).toBe(1);
  }
}

function seeded(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}
const randomHex = (rand: () => number) => `#${Math.floor(rand() * 0xffffff).toString(16).padStart(6, '0')}`;
const hueGap = (a: number, b: number) => {
  const d = Math.abs(a - b) % (2 * Math.PI);
  return ((d > Math.PI ? 2 * Math.PI - d : d) * 180) / Math.PI;
};

describe('the name pill text colour', () => {
  it('reaches 4.5:1 on every built-in colour and every session step of each', () => {
    for (const color of BUILT_IN) {
      for (let ordinal = 1; ordinal <= AGENT_CURSOR_SESSION_LIGHTNESS.length; ordinal += 1) {
        const fill = sessionFill(color, { ordinal });
        expect(contrastRatio(fill, inkFor(fill)), `${color} session ${ordinal} (${fill})`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('reaches 4.5:1 on any colour (500 seeded random fills)', () => {
    const rand = seeded(20261031);
    for (let i = 0; i < 500; i += 1) {
      const fill = randomHex(rand);
      expect(contrastRatio(fill, inkFor(fill)), fill).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('keeps the dark ink on Claude, Codex and the palette, as before; white on a dark custom colour', () => {
    for (const color of BUILT_IN) expect(inkFor(color), color).toBe(AGENT_CURSOR_INK_DARK);
    expect(inkFor('#3a6a9a')).toBe(AGENT_CURSOR_INK_LIGHT);
    expect(contrastRatio('#3a6a9a', AGENT_CURSOR_INK_LIGHT)).toBeGreaterThan(4.5);
    expect(inkFor('#000000')).toBe(AGENT_CURSOR_INK_LIGHT);
    expect(inkFor('#ffffff')).toBe(AGENT_CURSOR_INK_DARK);
  });

  it('falls back to black on the mid-luminance band where neither ink reaches 4.5:1', () => {
    expect(contrastRatio('#138c03', AGENT_CURSOR_INK_DARK)).toBeLessThan(4.5);
    expect(contrastRatio('#138c03', AGENT_CURSOR_INK_LIGHT)).toBeLessThan(4.5);
    expect(inkFor('#138c03')).toBe(AGENT_CURSOR_INK_BLACK);
    expect(contrastRatio('#138c03', AGENT_CURSOR_INK_BLACK)).toBeGreaterThanOrEqual(4.5);
  });
});

describe('sessions of one agent', () => {
  it('names the first by the agent and numbers the rest in order of appearance', () => {
    expect(sessionName('Claude', null)).toBe('Claude');
    expect(sessionName('Claude', { ordinal: 1 })).toBe('Claude');
    expect(sessionName('Claude', { ordinal: 2 })).toBe('Claude · 2');
    expect(sessionName('Claude', { ordinal: 3 })).toBe('Claude · 3');
    expect(sessionName('Claude', { ordinal: 2.5 })).toBe('Claude');
  });

  it("uses a chat's title when Nebula has one, cut at 20 characters", () => {
    expect(sessionName('Claude', { ordinal: 2 }, 'Lighting pass')).toBe('Claude · Lighting pass');
    expect(sessionName('Claude', { ordinal: 2 }, 'A very long chat title that runs on')).toBe('Claude · A very long chat tit');
    expect(sessionName('Claude', { ordinal: 2 }, '   ')).toBe('Claude · 2');
    // Cut by grapheme: a flag, an accent and a family emoji stay whole.
    const flag = `${'a'.repeat(19)}🇺🇸xyz`;
    expect(sessionName('Claude', null, flag)).toBe(`Claude · ${'a'.repeat(19)}🇺🇸`);
    const accent = `${'a'.repeat(19)}e\u0301xyz`;
    expect(sessionName('Claude', null, accent)).toBe(`Claude · ${'a'.repeat(19)}e\u0301`);
    const family = `${'a'.repeat(19)}👨‍👩‍👧‍👦 more`;
    expect(sessionName('Claude', null, family)).toBe(`Claude · ${'a'.repeat(19)}👨‍👩‍👧‍👦`);
  });

  it("keeps the agent's colour exactly for its first session", () => {
    expect(sessionFill(CLAUDE, null)).toBe(CLAUDE);
    expect(sessionFill(CLAUDE, { ordinal: 1 })).toBe(CLAUDE);
    expect(sessionFill('not a colour', { ordinal: 2 })).toBe('not a colour');
  });

  it('pins the offsets and the band (GM - Design, PR #211 r2)', () => {
    expect(AGENT_CURSOR_SESSION_LIGHTNESS).toEqual([0, -0.1, 0.1, -0.2, 0.2]);
    expect(AGENT_CURSOR_SESSION_BAND).toEqual({ max: 0.92, min: 0.35, minGap: 0.05, clampGap: 0.07 });
  });

  it('steps L by 0, −0.10, +0.10, −0.20, +0.20 in the band, clamps or steps on past it, and cycles after five', () => {
    // Mid L: the plain offsets.
    expect([1, 2, 3, 4, 5].map((n) => +sessionLightness(0.6, n).toFixed(6))).toEqual([0.6, 0.5, 0.7, 0.4, 0.8]);
    const five = (L: number) => [1, 2, 3, 4, 5].map((n) => +sessionLightness(L, n).toFixed(6));
    // Light: +0.10 passes 0.92 and clamps to it (exactly 0.07 from 0.85);
    // +0.20 finds 0.92 taken, so the last steps on by 0.10 inside the band
    // (GM - Design, PR #211 r7 and r8).
    expect(five(0.85)).toEqual([0.85, 0.75, 0.92, 0.65, 0.55]);
    // Dark: −0.10 falls under 0.35, which is only 0.05 from 0.40, so the
    // clamp is refused (it needs 0.07) and the sessions step up (r8).
    expect(five(0.4)).toEqual([0.4, 0.5, 0.6, 0.7, 0.8]);
    // Pure white is pulled to 0.92 before stepping (GM - Design, PR #211 r3), never #ffffff.
    expect(five(1)).toEqual([0.92, 0.82, 0.72, 0.62, 0.52]);
    for (const L of [0.36, 0.5, 0.6, 0.85, 0.91]) {
      expect(sessionLightness(L, 6)).toBe(sessionLightness(L, 1));
      expect(sessionLightness(L, 7)).toBe(sessionLightness(L, 2));
    }
  });

  it('keeps five sessions apart (ΔL ≥ 0.05), inside 0.35-0.92, in the same hue, for every built-in colour', () => {
    for (const color of BUILT_IN) {
      const base = hexToOklch(color)!;
      const Ls = [1, 2, 3, 4, 5].map((n) => sessionLightness(base.l, n));
      for (let i = 0; i < 5; i += 1) {
        for (let j = i + 1; j < 5; j += 1) expect(Math.abs(Ls[i] - Ls[j]), `${color} ${i + 1}/${j + 1}`).toBeGreaterThanOrEqual(0.05 - 1e-9);
        expect(Ls[i]).toBeLessThanOrEqual(0.92);
        expect(Ls[i]).toBeGreaterThanOrEqual(0.35);
      }
      const fills = [1, 2, 3, 4, 5].map((ordinal) => sessionFill(color, { ordinal }));
      expect(new Set(fills.map((f) => f.toLowerCase())).size, color).toBe(5);
      for (const [i, fill] of fills.entries()) {
        expect(fill.toLowerCase()).not.toBe('#ffffff');
        const got = hexToOklch(fill)!;
        expect(Math.abs(got.l - Ls[i]), `${color} #${i + 1} L`).toBeLessThan(0.006);
        if (got.c > 0.03) expect(hueGap(got.h, base.h), `${color} #${i + 1} hue`).toBeLessThan(2.5);
        // Chroma is kept wherever sRGB allows: a hue that shows.
        expect(got.c, `${color} #${i + 1} chroma`).toBeGreaterThan(0.04);
      }
      expect(sessionFill(color, { ordinal: 6 })).toBe(sessionFill(color, { ordinal: 1 }));
    }
    // Two Claude sessions look like Claude, and like two.
    expect(sessionFill(CLAUDE, { ordinal: 2 })).not.toBe(CLAUDE);
  });

  it('holds session 1 in the band too: black starts visible at L 0.35, white at 0.92 (GM - Design, PR #211 r3)', () => {
    const five = (L: number) => [1, 2, 3, 4, 5].map((n) => +sessionLightness(L, n).toFixed(6));
    // The three lists GM confirmed: black steps up from the band's floor.
    expect(five(0)).toEqual([0.35, 0.45, 0.55, 0.65, 0.75]);
    expect(five(0.85)).toEqual([0.85, 0.75, 0.92, 0.65, 0.55]);
    expect(five(1)).toEqual([0.92, 0.82, 0.72, 0.62, 0.52]);
    // A base past either edge is pulled to it before any stepping.
    expect(sessionLightness(0.95, 1)).toBeCloseTo(0.92, 9);
    expect(five(0.95)).toEqual(five(1));
    expect(sessionLightness(0.2, 1)).toBeCloseTo(0.35, 9);
    expect(five(0.2)).toEqual(five(0));
    // #000000 and #030303 share one session-1 fill, and it is visible: L 0.35.
    const black = sessionFill('#000000', { ordinal: 1 });
    expect(sessionFill('#030303', { ordinal: 1 })).toBe(black);
    expect(hexToOklch(black)!.l).toBeCloseTo(0.35, 2);
    expect(black.toLowerCase()).not.toBe('#000000');
    // Inside the band the agent's colour is kept exactly.
    expect(sessionFill(CLAUDE, { ordinal: 1 })).toBe(CLAUDE);
  });

  it('clamps a step past the band to its edge when the edge has 0.07 of room, on both sides (GM - Design, PR #211 r7 and r8)', () => {
    const five = (L: number) => [1, 2, 3, 4, 5].map((n) => +sessionLightness(L, n).toFixed(4));
    // The pink external colour (#FF6B9A, L 0.7226): +0.20 is 0.9226, past
    // 0.92 by 0.0026. Clamped it sits at 0.92 (0.097 from · 3's 0.8226) and
    // stays the lightest; before round 3b it went darkest (0.4226).
    const pink = hexToOklch('#FF6B9A')!.l;
    expect(pink).toBeCloseTo(0.7226, 4);
    expect(five(pink)).toEqual([0.7226, 0.6226, 0.8226, 0.5226, 0.92]);
    const fills = [1, 2, 3, 4, 5].map((ordinal) => sessionFill('#FF6B9A', { ordinal }));
    expect(fills).toEqual(['#FF6B9A', '#db4a7c', '#ffa8be', '#b8265f', '#ffd9e2']);
    const Ls = fills.map((f) => hexToOklch(f)!.l);
    expect(Math.max(...Ls)).toBe(Ls[4]);
    expect(Math.min(...Ls)).toBe(Ls[3]);
    // Low side: from 0.52, −0.20 is 0.32 and clamps to 0.35, exactly 0.07
    // from · 2's 0.42; from 0.519 that gap is 0.069 and the clamp is refused.
    expect(five(0.52)).toEqual([0.52, 0.42, 0.62, 0.35, 0.72]);
    expect(five(0.519)).toEqual([0.519, 0.419, 0.619, 0.719, 0.819]);
    // From 0.47 the edge is 0.02 from · 2's 0.37: −0.20 is refused and
    // takes +0.20's 0.67, and · 5 steps on to 0.77.
    expect(five(0.47)).toEqual([0.47, 0.37, 0.57, 0.67, 0.77]);
    // The real Claude never reaches the edge: its five are the plain offsets.
    const claude = hexToOklch(CLAUDE)!.l;
    expect([1, 2, 3, 4, 5].map((n) => sessionLightness(claude, n) - claude).map((d) => +d.toFixed(6))).toEqual([0, -0.1, 0.1, -0.2, 0.2]);
    expect([1, 2, 3, 4, 5].map((ordinal) => sessionFill(CLAUDE, { ordinal }))).toEqual(['#E8825A', '#c6633b', '#ffa887', '#a4451b', '#ffd8c9']);
  });

  it('takes a clamp at exactly 0.07 of room and refuses it just under (GM - Design, PR #211 r8)', () => {
    const five = (L: number) => [1, 2, 3, 4, 5].map((n) => +sessionLightness(L, n).toFixed(4));
    // Top edge: from 0.85, +0.10 clamps to 0.92, exactly 0.07 above the base.
    expect(five(0.85)).toEqual([0.85, 0.75, 0.92, 0.65, 0.55]);
    // A base of 0.92 − 0.07 is 0.8500000000000001 in floating point, so its
    // gap to the edge rounds to 0.06999999999999995: the epsilon still takes it.
    expect(five(0.92 - 0.07)).toEqual([0.85, 0.75, 0.92, 0.65, 0.55]);
    // From 0.851 the edge is 0.069 above: refused, so · 3 takes −0.20's
    // 0.651, and +0.10 and +0.20, still refused, step on down by 0.10.
    expect(five(0.851)).toEqual([0.851, 0.751, 0.651, 0.551, 0.451]);
    // Floor: from 0.42, −0.10 clamps to 0.35, exactly 0.07 under the base
    // (0.42 − 0.35 is 0.07 in floating point, so only >= with an epsilon takes it).
    expect(five(0.42)).toEqual([0.42, 0.35, 0.52, 0.62, 0.72]);
    expect(five(0.419)).toEqual([0.419, 0.519, 0.619, 0.719, 0.819]);
    // +0.20 at the top: from 0.75 the edge is exactly 0.07 above · 3's 0.85.
    expect(five(0.75)).toEqual([0.75, 0.65, 0.85, 0.55, 0.92]);
    expect(five(0.751)).toEqual([0.751, 0.651, 0.851, 0.551, 0.451]);
  });

  it('for every base L from 0 to 1, sessions 1-5 stay in 0.35-0.92 and at least 0.05 apart (review 2)', () => {
    for (let i = 0; i <= 1000; i += 1) {
      const base = i / 1000;
      const Ls = [1, 2, 3, 4, 5].map((n) => sessionLightness(base, n));
      for (const L of Ls) {
        expect(L, `base ${base}`).toBeGreaterThanOrEqual(0.35 - 1e-9);
        expect(L, `base ${base}`).toBeLessThanOrEqual(0.92 + 1e-9);
      }
      for (let a = 0; a < 5; a += 1) {
        for (let b = a + 1; b < 5; b += 1) expect(Math.abs(Ls[a] - Ls[b]), `base ${base} ${a + 1}/${b + 1}`).toBeGreaterThanOrEqual(0.05 - 1e-9);
      }
    }
  });

  it('never fills pure white, and keeps sessions of the extremes apart', () => {
    for (const color of ['#ffffff', '#FFFFFF', '#fafafa', '#fefefe', '#ffff00', '#000000', '#0000ff', '#00ff00', '#ff0000', '#808080']) {
      const fills = [1, 2, 3, 4, 5, 6].map((ordinal) => sessionFill(color, { ordinal }).toLowerCase());
      for (const fill of fills) expect(fill, color).not.toBe('#ffffff');
      expect(new Set(fills.slice(0, 5)).size, color).toBe(5);
    }
  });

  it('always returns a valid colour, lowering chroma to stay in sRGB', () => {
    const rand = seeded(7);
    for (let i = 0; i < 200; i += 1) {
      const color = randomHex(rand);
      for (let ordinal = 1; ordinal <= 4; ordinal += 1) expect(sessionFill(color, { ordinal })).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
    expect(sessionFill('#ffffff', { ordinal: 2 })).not.toBe('#ffffff');
  });
});

describe('the name rule', () => {
  const base = { moving: false, peers: 1, hovered: false, sinceFirstSightMs: 10_000 };
  it('a lone cursor hides its name while it moves, whatever else holds', () => {
    expect(nameVisible({ moving: true, peers: 1, hovered: true, sinceFirstSightMs: 0 })).toBe(false);
  });
  it('with two or more cursors the name holds its slot while moving (GM - Design, PR #211 r2)', () => {
    expect(nameVisible({ moving: true, peers: 2, hovered: false, sinceFirstSightMs: 10_000 })).toBe(true);
    expect(nameVisible({ moving: true, peers: 5, hovered: false, sinceFirstSightMs: 10_000 })).toBe(true);
  });
  it('pins the first sighting at 1.5 s', () => {
    expect(AGENT_CURSOR_NAME_FIRST_SIGHT_MS).toBe(1500);
  });
  it('shows it with two or more cursors, on hover, and for 1.5 s on a first sighting', () => {
    expect(nameVisible(base)).toBe(false);
    expect(nameVisible({ ...base, peers: 2 })).toBe(true);
    expect(nameVisible({ ...base, hovered: true })).toBe(true);
    expect(nameVisible({ ...base, sinceFirstSightMs: 0 })).toBe(true);
    expect(nameVisible({ ...base, sinceFirstSightMs: AGENT_CURSOR_NAME_FIRST_SIGHT_MS - 1 })).toBe(true);
    expect(nameVisible({ ...base, sinceFirstSightMs: AGENT_CURSOR_NAME_FIRST_SIGHT_MS })).toBe(false);
  });
  it("moves the say pill into the name's slot when the name is hidden", () => {
    expect(labelLayout(false, false)).toBe('none');
    expect(labelLayout(true, false)).toBe('name');
    expect(labelLayout(false, true)).toBe('say');
    expect(labelLayout(true, true)).toBe('name+say');
  });
});

// The painted shapes, measured apart from agentCursorLook's own geometry: a
// signed distance from each shape (negative inside), and points sampled
// along each outline. Arrow: the path at its tip, stroke 1.4. Name pill:
// round ends, the 1 px edge ring. Say pill: round ends, 4 px under the name.
type P = { x: number; y: number };
const ARROW: P[] = [[1.5, 1.5], [1.5, 17.5], [6, 13.3], [9.1, 20.1], [11.9, 18.9], [8.9, 12.3], [14.7, 12.1]]
  .map(([x, y]) => ({ x, y }));
const NAME_W = 64;
const SAY_W = 140;

function segDist(p: P, a: P, b: P): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}
function inPolygon(p: P, poly: P[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i, i += 1) {
    const a = poly[i];
    const b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
interface Shape { sdf: (p: P) => number; outline: P[] }
function arrowAt(o: P): Shape {
  const poly = ARROW.map((v) => ({ x: v.x + o.x, y: v.y + o.y }));
  const outline: P[] = [];
  for (let i = 0; i < poly.length; i += 1) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const n = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 0.2);
    for (let k = 0; k < n; k += 1) outline.push({ x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n });
  }
  const sdf = (p: P) => {
    const d = Math.min(...poly.map((a, i) => segDist(p, a, poly[(i + 1) % poly.length])));
    return (inPolygon(p, poly) ? -d : d) - 0.7;
  };
  return { sdf, outline };
}
function pillAt(left: number, top: number, width: number, grow: number): Shape {
  const r = 10;
  const sdf = (p: P) => {
    const cx = Math.min(Math.max(p.x, left + r), left + width - r);
    return Math.hypot(p.x - cx, p.y - (top + r)) - r - grow;
  };
  const outline: P[] = [];
  const R = r + grow;
  for (let a = 0; a < 2 * Math.PI; a += 0.02) {
    const cx = Math.cos(a) < 0 ? left + r : left + width - r;
    outline.push({ x: cx + R * Math.cos(a), y: top + r + R * Math.sin(a) });
  }
  for (let x = left + r; x <= left + width - r; x += 0.25) outline.push({ x, y: top - grow }, { x, y: top + 2 * r + grow });
  return { sdf, outline };
}
function pillsAt(o: P, say: boolean): Shape[] {
  const name = pillAt(o.x + 15, o.y + 17, NAME_W, 1);
  return say ? [name, pillAt(o.x + 15, o.y + 41, SAY_W, 0)] : [name];
}
/** The painted gap between two shapes: the least signed distance from
 *  either's outline to the other (negative when they overlap). The arrow's
 *  outline is its path; its sdf carries the stroke. */
function gap(a: Shape, b: Shape): number {
  const ab = Math.min(...a.outline.map((p) => b.sdf(p)));
  const ba = Math.min(...b.outline.map((p) => a.sdf(p)));
  return Math.min(ab, ba);
}
/** Every painted part of cursor i against every part of cursor j: arrows
 *  against pills and pills against pills (arrows may come close to arrows). */
function paintedGap(i: P, sayI: boolean, j: P, sayJ: boolean, arrows = false): number {
  // Far apart by their boxes: no need to sample.
  const box = (o: P, say: boolean) => ({ l: o.x, r: o.x + 15 + Math.max(NAME_W + 1, say ? SAY_W : 0), t: o.y, b: o.y + (say ? 61 : 38) });
  const a = box(i, sayI);
  const b = box(j, sayJ);
  const far = Math.hypot(Math.max(0, a.l - b.r, b.l - a.r), Math.max(0, a.t - b.b, b.t - a.b));
  if (far > 4) return far;
  let least = Infinity;
  for (const [x, y, sy] of [[i, j, sayJ], [j, i, sayI]] as [P, P, boolean][]) {
    for (const pill of pillsAt(y, sy)) least = Math.min(least, gap(pill, arrowAt(x)));
  }
  for (const p of pillsAt(i, sayI)) for (const q of pillsAt(j, sayJ)) least = Math.min(least, gap(p, q));
  // Arrow against arrow: both strokes (gap() counts one).
  if (arrows) least = Math.min(least, gap(arrowAt(i), arrowAt(j)) - 0.7);
  return least;
}
/** Is j's arrow beside or over i's label, inside what i owns: from i's
 *  arrow top to 4 px under its label block, across arrow and pills (GM -
 *  Design, PR #211 r14)? Measured from the CSS numbers, not the module. */
function ownsArrowOf(i: P, sayI: boolean, j: P): boolean {
  const unit = { l: i.x + 0.8, r: i.x + 15 + Math.max(NAME_W + 1, sayI ? SAY_W : 0), t: i.y + 0.8, b: i.y + (sayI ? 61 : 38) + 4 };
  const arrow = { l: j.x + 0.8, r: j.x + 15.4, t: j.y + 0.8, b: j.y + 20.8 };
  return arrow.l < unit.r && arrow.r > unit.l && arrow.t < unit.b && arrow.b > unit.t;
}

describe('no stacking (GM - Design, PR #211 r12, r13 and r14; review 6)', () => {
  const S = stackStepPx(false);
  const SS = stackStepPx(true);
  /** A cursor as the layer passes it, with the widths the helpers above draw. */
  const entry = (key: string, x: number, y: number, since: number, say = false) =>
    ({ key, target: { x, y }, since, say, nameW: NAME_W, sayW: SAY_W });

  it("steps the later tip 4 px under the earlier label block's bottom: 42 below a name, 65 below a name and a say (r14)", () => {
    // From the CSS numbers: the arrow's painted top is 1.5 - 0.7; the name
    // pill ends at 17 + 20, plus its 1 px ring; a say pill 4 px under it ends
    // at 61. GM's "about 39 and about 65" measured the tip without the
    // stroke and the name without its ring.
    expect(S).toBe(Math.ceil(17 + 20 + 1 + 4 - 0.8));
    expect(SS).toBe(Math.ceil(17 + 20 + 4 + 20 + 4 - 0.8));
    expect([S, SS]).toEqual([42, 65]);
    for (const say of [false, true]) {
      const step = stackStepPx(say);
      // The painted check stays a floor, measured apart from the module.
      expect(paintedGap({ x: 0, y: 0 }, say, { x: 0, y: step }, false)).toBeGreaterThanOrEqual(2 - 0.02);
      expect(stackClearancePx(step, say)).toBeGreaterThanOrEqual(AGENT_CURSOR_STACK.clearPx);
      // Each arrow sits by its own label only: at the step it is clear of
      // what the earlier cursor owns; one px up, it is beside its label.
      expect(ownsArrowOf({ x: 0, y: 0 }, say, { x: 0, y: step })).toBe(false);
      expect(ownsArrowOf({ x: 0, y: 0 }, say, { x: 0, y: step - 1 })).toBe(true);
    }
  });

  it('measures the arrow the layer draws', () => {
    expect(AGENT_CURSOR_ARROW_POINTS).toEqual(ARROW);
    expect(AGENT_CURSOR_ARROW_PATH).toBe(`M${ARROW.map((p) => `${p.x} ${p.y}`).join(' L')} Z`);
    const layer = readFileSync(resolve(__dirname, '../src/components/canvas/AgentCursorLayer.tsx'), 'utf8');
    expect(layer).toMatch(/<path className="agent-cursor__arrow" d=\{AGENT_CURSOR_ARROW_PATH\} \/>/);
  });

  it('lands a later cursor straight below an earlier one within 16 px, never to the right', () => {
    const spots = deStack([
      { key: 'b', target: { x: 105, y: 100 }, since: 2 },
      { key: 'a', target: { x: 100, y: 100 }, since: 1 },
    ], 1);
    expect(spots.get('a')).toEqual({ x: 100, y: 100 });
    expect(spots.get('b')).toEqual({ x: 100, y: 100 + S });
  });

  it('leaves cursors where they are when apart: past the radius and clear of every label', () => {
    // Right of the name pill, and below what the earlier cursor owns.
    for (const b of [{ x: 100 + 15 + NAME_W + 1 + 4, y: 100 }, { x: 100, y: 100 + 43 }, { x: 40, y: 40 }]) {
      const spots = deStack([entry('a', 100, 100, 1), { ...entry('b', b.x, b.y, 2) }], 1);
      expect(spots.get('b')).toEqual(b);
    }
  });

  it('steps past the earlier label block: name, plus the say pill while one shows', () => {
    const at = (say: boolean[]) => [...deStack(say.map((s, i) => ({
      key: String(i), target: { x: 0, y: 0 }, since: i + 1, say: s,
    })), 1).values()];
    expect(at([false, false, false])).toEqual([{ x: 0, y: 0 }, { x: 0, y: S }, { x: 0, y: 2 * S }]);
    expect(at([false, true, false])).toEqual([{ x: 0, y: 0 }, { x: 0, y: S }, { x: 0, y: S + SS }]);
    expect(at([true, false, false])).toEqual([{ x: 0, y: 0 }, { x: 0, y: SS }, { x: 0, y: SS + S }]);
  });

  it('never lands on an earlier tip: one aimed up-left of it joins its column (review 1, F1)', () => {
    const spots = deStack([
      { key: 'a', target: { x: 0, y: 0 }, since: 1 },
      { key: 'b', target: { x: -10, y: -10 }, since: 2 },
    ], 1);
    expect(spots.get('a')).toEqual({ x: 0, y: 0 });
    expect(spots.get('b')).toEqual({ x: 0, y: S });
  });

  it('joining is transitive on targets: a chain of near targets is one column, ordered by arrival (review 5, M2)', () => {
    const spots = deStack([
      { key: 'a', target: { x: 0, y: 0 }, since: 1 },
      { key: 'c', target: { x: 10, y: 10 }, since: 2 },
      { key: 'b', target: { x: 0, y: 0 }, since: 3 },
      // 16 px from c's target, not a's: it joins through c.
      { key: 'd', target: { x: 26, y: 10 }, since: 4 },
    ], 1);
    // The fourth folds into the third slot's count cursor (GM r17 item 1).
    expect([...spots.entries()]).toEqual([
      ['a', { x: 0, y: 0 }], ['c', { x: 0, y: S }], ['b', { x: 0, y: 2 * S }], ['d', { x: 0, y: 2 * S }],
    ]);
  });

  it('joining on targets reaches as far as the chain does, past where any label could meet (GM r14: targets)', () => {
    // Each 16 px above the last: d's own spot is clear of everyone, but its
    // target is within 16 px of c's, so it is in the column.
    const spots = deStackLayout([entry('a', 0, 0, 1), entry('b', 0, -16, 2), entry('c', 0, -32, 3), entry('d', 0, -48, 4)], 1);
    expect([...spots.values()].map((spot) => spot.at)).toEqual([{ x: 0, y: 0 }, { x: 0, y: S }, { x: 0, y: 2 * S }, { x: 0, y: 2 * S }]);
    expect(spots.get('d')!.collapsedInto).toBe('c');
  });

  it('orders by when each came to its spot, not by its last event (review 1, F2)', () => {
    const spots = deStack([
      { key: 'b', target: { x: 0, y: 0 }, since: 2 },
      { key: 'a', target: { x: 0, y: 0 }, since: 1 },
    ], 1);
    expect(spots.get('a')).toEqual({ x: 0, y: 0 });
    expect(spots.get('b')).toEqual({ x: 0, y: S });
  });

  it('measures in screen px at any zoom', () => {
    // 5 flow px is 10 screen px at zoom 2: stacked, a step of S / 2 flow px.
    expect(deStack([entry('a', 0, 0, 1), entry('b', 5, 0, 2)], 2).get('b')).toEqual({ x: 0, y: S / 2 });
    // 100 flow px right: 200 screen px at zoom 2, apart; 25 at zoom 0.25,
    // on the name pill, so it joins.
    expect(deStack([entry('a', 0, 0, 1), entry('b', 100, 0, 2)], 2).get('b')).toEqual({ x: 100, y: 0 });
    expect(deStack([entry('a', 0, 0, 1), entry('b', 100, 0, 2)], 0.25).get('b')).toEqual({ x: 0, y: S / 0.25 });
  });

  it('a column rides its node as one: moving every target moves every spot the same', () => {
    const at = (dx: number, dy: number) => deStack([0, 1, 2].map((i) => ({
      key: String(i), target: { x: 200 + dx + (i === 2 ? 9 : 0), y: 100 + dy }, since: i + 1, say: i === 1,
    })), 1);
    const rest = at(0, 0);
    for (const [dx, dy] of [[3, 0], [0, 7.5], [-40, 12], [250, -90]]) {
      const moved = at(dx, dy);
      for (const [key, spot] of rest) expect(moved.get(key)).toEqual({ x: spot.x + dx, y: spot.y + dy });
    }
  });

  it.each([2, 3])('%i cursors on one target, says on and off: no painted arrow or pill within 2 px of another', (count) => {
    for (let mask = 0; mask < 2 ** count; mask += 1) {
      const says = Array.from({ length: count }, (_, i) => Boolean(mask & (1 << i)));
      const spots = [...deStack(says.map((say, i) => ({ key: String(i), target: { x: 50, y: 50 }, since: i + 1, say })), 1).values()];
      for (const spot of spots) expect(spot.x).toBe(50);
      for (let i = 0; i < count; i += 1) {
        for (let j = i + 1; j < count; j += 1) {
          expect(paintedGap(spots[i], says[i], spots[j], says[j])).toBeGreaterThanOrEqual(2 - 0.02);
        }
      }
    }
  });

  it('near targets 9 to 16 px apart, 2 and 3 cursors, says on and off: no painted overlap (review 5, M2)', () => {
    const aims: P[] = [];
    for (let dx = -16; dx <= 16; dx += 2) {
      for (let dy = -16; dy <= 16; dy += 2) {
        const d = Math.hypot(dx, dy);
        if (d >= 9 && d <= 16) aims.push({ x: dx, y: dy });
      }
    }
    for (const aim of aims) {
      for (const sayA of [false, true]) {
        const spots = deStack([
          entry('a', 0, 0, 1, sayA),
          entry('b', aim.x, aim.y, 2),
          // A third aimed back the other way from the second.
          entry('c', -aim.y / 2, aim.x / 2, 3),
        ], 1);
        const [a, b, c] = ['a', 'b', 'c'].map((k) => spots.get(k)!);
        // b may sit under c now: c goes in above a member aimed more than
        // 16 px below it (r24 Q1). The column is one, at a's x.
        expect(b.x).toBe(0);
        expect(c.x).toBe(0);
        expect(paintedGap(a, sayA, b, false, true)).toBeGreaterThanOrEqual(2 - 0.02);
        expect(paintedGap(b, false, c, false, true)).toBeGreaterThanOrEqual(2 - 0.02);
        expect(paintedGap(a, sayA, c, false, true)).toBeGreaterThanOrEqual(2 - 0.02);
      }
    }
  }, 30_000);

  // Review 6, HIGH-2: the cases it found painting over each other at rest.
  it('(0, 19): a target 19 px straight below, past the radius, still joins: its arrow would sit by the label above', () => {
    const spots = deStack([entry('a', 0, 0, 1), entry('b', 0, 19, 2)], 1);
    expect(spots.get('b')).toEqual({ x: 0, y: S });
    expect(paintedGap(spots.get('a')!, false, spots.get('b')!, false, true)).toBeGreaterThanOrEqual(2 - 0.02);
    expect(ownsArrowOf(spots.get('a')!, false, spots.get('b')!)).toBe(false);
  });

  it('(0, 30, 15): a cursor bridging two goes under both, and the column takes in the one it meets', () => {
    const spots = deStack([entry('a', 0, 0, 1), entry('b', 0, 30, 2), entry('c', 0, 15, 3)], 1);
    expect([...spots.values()]).toEqual([{ x: 0, y: 0 }, { x: 0, y: S }, { x: 0, y: 2 * S }]);
  });

  it('(0, 60, 0, 0): a column growing down into an earlier cursor takes it in; it stays on its own target and the next steps on under it (r23)', () => {
    const spots = deStack([entry('a', 0, 0, 1), entry('b', 0, 60, 2), entry('c', 0, 0, 3), entry('d', 0, 0, 4)], 1);
    // b is past a's label (60 > 42), so it rests on its target; c would land
    // at 42, over b's arrow, so b's column joins a's. The joined column is
    // laid out in arrival order (GM r21), never above a member's own target
    // (r23 item 1): a, then b at its own target 60 (its slot, 42, is above
    // it: a gap), then c a step under b, the count, with d folded into it.
    expect([...spots.values()]).toEqual([{ x: 0, y: 0 }, { x: 0, y: 60 }, { x: 0, y: 60 + S }, { x: 0, y: 60 + S }]);
  });

  // Review 8, MEDIUM-1: joins first, then each final column in arrival
  // order, the count in the last slot (GM r21).
  it.each([86, 88, 90, 95, 100])('P1: two columns of two (the second at %s px) merge when a fifth comes: arrival order, the count last', (by) => {
    const list = [entry('A1', 0, 0, 1), entry('A2', 0, 0, 2), entry('B1', 0, by, 3), entry('B2', 0, by, 4), entry('C', 0, 0, 5)];
    const laid = deStackLayout(list, 1);
    expectColumnsCapped(list, laid);
    expect(laid.get('A1')!.at).toEqual({ x: 0, y: 0 });
    expect(laid.get('A2')!.at).toEqual({ x: 0, y: S });
    // The count: exactly one step under the last full cursor, no gap, even
    // when its own target is lower (r24 Q1).
    expect(laid.get('B1')!.at).toEqual({ x: 0, y: 2 * S });
    expect(laid.get('B1')!.group).toEqual(['B1', 'B2', 'C']);
    expect(laid.get('B2')!.collapsedInto).toBe('B1');
    expect(laid.get('C')!.collapsedInto).toBe('B1');
  });

  // Review 8, L8 and L9: a folded member is drawn as its slot, so its spot
  // has the slot's members above it; and its spot changes (sig) whenever
  // its slot does, so the layer re-aims it at its new count cursor.
  it('a folded member has its slot\'s members above it, and a new slot gives it a new spot (L8, L9)', () => {
    const five = ['a', 'b', 'c', 'd', 'e'].map((k, i) => entry(k, 0, 0, i + 1));
    const laid = deStackLayout(five, 1);
    expect(laid.get('c')!.group).toEqual(['c', 'd', 'e']);
    for (const k of ['d', 'e']) {
      expect(laid.get(k)!.above).toEqual(laid.get('c')!.above);
      expect(laid.get(k)!.above).toEqual(['a', 'b']);
      expect(laid.get(k)!.sig).not.toBe(laid.get('c')!.sig);
    }
    // c leaves: d is the count now, e folds into it at the same point.
    const after = deStackLayout(five.filter((e) => e.key !== 'c'), 1);
    expect(after.get('d')!.group).toEqual(['d', 'e']);
    expect(after.get('e')!.collapsedInto).toBe('d');
    expect(after.get('e')!.at).toEqual(laid.get('e')!.at);
    expect(after.get('e')!.above).toEqual(['a', 'b']);
    expect(after.get('e')!.sig).not.toBe(laid.get('e')!.sig);
  });

  it('P3: an earlier cursor whose column is joined stays full and on its target; a later one aimed higher goes in above it (r24 Q1)', () => {
    const list = [entry('B1', 0, 86, 1), entry('A1', 0, 0, 2), entry('A2', 0, 0, 3), entry('C', 0, 0, 4)];
    const laid = deStackLayout(list, 1);
    expectColumnsCapped(list, laid);
    // B1 came first and stays full, on its own target. A1 aims 86 px
    // higher, so it goes in above B1, on its own target; A2 is the count
    // for itself and C, one step under B1.
    expect(laid.get('A1')!.at).toEqual({ x: 0, y: 0 });
    expect(laid.get('B1')!.at).toEqual({ x: 0, y: 86 });
    expect(laid.get('B1')!.collapsedInto).toBeUndefined();
    expect(laid.get('B1')!.group).toBeUndefined();
    expect(laid.get('A2')!.at).toEqual({ x: 0, y: 86 + S });
    expect(laid.get('A2')!.group).toEqual(['A2', 'C']);
    // Before C came, the two columns were apart: A1 and A2 on their own.
    const two = deStackLayout(list.slice(0, 3), 1);
    expect(two.get('A1')!.at).toEqual({ x: 0, y: 0 });
    expect(two.get('A1')!.column).toBe('A1');
  });

  it('property (review 8\'s fuzz): 1,500 sets of 4 to 8 in a narrow strip at zooms 0.25 to 3, merging often: every column capped, the count last, full only for the two earliest', () => {
    const rand = seeded(8811);
    let merged = 0;
    let counted = 0;
    for (let round = 0; round < 1500; round += 1) {
      const zoom = [0.25, 0.5, 0.8, 1, 1.5, 2, 3][Math.floor(rand() * 7)];
      const count = 4 + Math.floor(rand() * 5);
      const list = Array.from({ length: count }, (_, i) => entry(
        String.fromCharCode(97 + i),
        (Math.floor(rand() * 3) * 4) / zoom,
        (rand() * 220) / zoom,
        i + 1,
        rand() < 0.3,
      ));
      const laid = deStackLayout(list, zoom);
      const columns = expectColumnsCapped(list, laid, zoom);
      expectColumnsJustified(list, laid, zoom);
      for (const members of columns.values()) {
        if (members.length > AGENT_CURSOR_COLUMN_DRAWN) counted += 1;
        // A column of members whose own targets are far apart: a merge.
        const ys = members.map((m) => list.find((e) => e.key === m.key)!.target.y * zoom);
        if (Math.max(...ys) - Math.min(...ys) > 60) merged += 1;
      }
      // Nothing drawn meets across columns, arrows and names.
      const drawn = list.filter((e) => !laid.get(e.key)!.collapsedInto);
      const shapes = drawn.map((e) => ({ col: laid.get(e.key)!.column, shape: cursorShape({ x: laid.get(e.key)!.at.x * zoom, y: laid.get(e.key)!.at.y * zoom }, false, e.nameW) }));
      for (let i = 0; i < shapes.length; i += 1) {
        for (let j = i + 1; j < shapes.length; j += 1) {
          if (shapes[i].col !== shapes[j].col) expect(cursorsMeet(shapes[i].shape, shapes[j].shape)).toBe(false);
        }
      }
    }
    expect(merged).toBeGreaterThan(300);
    expect(counted).toBeGreaterThan(300);
  }, 120_000);

  // Review 9, MEDIUM-1 and GM r23 item 1: review 9's own fuzz (20,000 sets
  // found 4,184 drawn cursors above their targets, the worst by 157 px).
  it('property (review 9\'s fuzz): 20,000 sets of 2 to 8, says on 30%: no drawn cursor above its own target, none more than its steps plus gaps below it, every column justified', () => {
    const rand = seeded(9911);
    let gapped = 0;
    let joined = 0;
    for (let round = 0; round < 20_000; round += 1) {
      const count = 2 + Math.floor(rand() * 7);
      const list = Array.from({ length: count }, (_, i) => entry(
        String.fromCharCode(97 + i), [0, 4, 8][Math.floor(rand() * 3)], rand() * 220, i + 1, rand() < 0.3));
      const laid = deStackLayout(list, 1);
      const columns = expectColumnsCapped(list, laid, 1);
      expectColumnsJustified(list, laid, 1);
      for (const members of columns.values()) {
        if (members.length > 1) joined += 1;
        // A member drawn on its own target below a full step: a gap.
        const drawn = members.filter((m) => !laid.get(m.key)!.collapsedInto);
        for (let k = 1; k < drawn.length; k += 1) {
          const step = laid.get(drawn[k].key)!.at.y - laid.get(drawn[k - 1].key)!.at.y;
          if (step > stackStepPx(true) + 1e-6) gapped += 1;
        }
      }
    }
    expect(joined).toBeGreaterThan(10_000);
    expect(gapped).toBeGreaterThan(1_000);
  }, 120_000);

  // #219 review 1, MEDIUM-1, and GM r24 Q1: the fuzz that found full
  // cursors drawn up to 318.8 px below their targets (seed 424242, review 9's
  // distribution). The stable insert bounds every one by 2 steps + 32 px.
  // CURSOR_FUZZ_STATS=1 prints the worst offsets for GM.
  it('property (review 1\'s fuzz, seed 424242): 20,000 sets, every full cursor within 2 steps + 32 px of its target, the count right under the last', () => {
    const rand = seeded(424242);
    Object.assign(fuzzStats, { cursors: 0, worstBelowPx: 0, worstBoundUsedPx: 0, atTarget: 0, counts: 0 });
    let inserted = 0;
    for (let round = 0; round < 20_000; round += 1) {
      const count = 2 + Math.floor(rand() * 7);
      const list = Array.from({ length: count }, (_, i) => entry(
        String.fromCharCode(97 + i), [0, 4, 8][Math.floor(rand() * 3)], rand() * 220, i + 1, rand() < 0.3));
      const laid = deStackLayout(list, 1);
      const columns = expectColumnsCapped(list, laid, 1);
      expectColumnsJustified(list, laid, 1);
      for (const members of columns.values()) {
        const full = (members.length > AGENT_CURSOR_COLUMN_DRAWN ? members.slice(0, 2) : members);
        if (insertOrder(full, 1).some((m, k) => m.key !== full[k].key)) inserted += 1;
      }
    }
    if (process.env.CURSOR_FUZZ_STATS) {
      process.stdout.write(`FUZZ-STATS ${JSON.stringify({ ...fuzzStats, insertedColumns: inserted,
        worstBelowPx: +fuzzStats.worstBelowPx.toFixed(3), worstBoundUsedPx: +fuzzStats.worstBoundUsedPx.toFixed(3),
        bound: `steps above + ${2 * AGENT_CURSOR_STACK.radiusPx}`, steps: [stackStepPx(false), stackStepPx(true)] })}\n`);
    }
    // Columns where a later arrival aimed higher went in above: the case
    // review 1 found, now inside the bound.
    expect(inserted).toBeGreaterThan(1_000);
    expect(fuzzStats.worstBoundUsedPx).toBeLessThanOrEqual(2 * AGENT_CURSOR_STACK.radiusPx + 1e-6);
  }, 120_000);

  it('review 1\'s mirror: e at 100 first, then f, g and h at 0: f goes in above e on its own target, e stays on its own, the count under e (r24 Q1)', () => {
    const list = [entry('e', 0, 100, 1), entry('f', 0, 0, 2), entry('g', 0, 0, 3), entry('h', 0, 0, 4)];
    const laid = deStackLayout(list, 1);
    expectColumnsCapped(list, laid, 1);
    expect([...laid].map(([k, v]) => [k, v.at.y, v.collapsedInto ?? v.group?.join('') ?? ''])).toEqual([
      ['e', 100, ''], ['f', 0, ''], ['g', 100 + S, 'gh'], ['h', 100 + S, 'g'],
    ]);
  });

  it('cursors aimed within 16 px of each other keep arrival order: a fuzzed target never reorders them (r24 Q1)', () => {
    const list = [entry('a', 0, 10, 1), entry('b', 0, 0, 2), entry('c', 0, -6, 3)];
    const laid = deStackLayout(list, 1);
    expectColumnsCapped(list, laid, 1);
    expect(laid.get('a')!.at.y).toBe(10);
    expect(laid.get('b')!.at.y).toBe(10 + S);
    expect(laid.get('c')!.at.y).toBe(10 + 2 * S);
    // 17 px higher than a: b goes in above it.
    const above = deStackLayout([entry('a', 0, 17, 1), entry('b', 0, 0, 2)], 1);
    expect(above.get('b')!.at.y).toBe(0);
    expect(above.get('a')!.at.y).toBe(Math.max(17, S));
  });

  // Review 9, NIT-1, checked: the first pass's meeting at a newcomer's own
  // target is a rule of its own, not redundant. c's arrow at its target
  // sits under a's label; c is also within 16 px of b. Without the check c
  // joins only b, is pushed a step under it, and a's label is never seen.
  it('a newcomer whose arrow at its own target meets a cursor joins its column, even when it also joins another (review 9 NIT-1)', () => {
    const list = [entry('a', 38, 114, 1), entry('b', 57, 157, 2), entry('c', 50, 155, 3)];
    const laid = deStackLayout(list, 1);
    expectColumnsCapped(list, laid, 1);
    expect([...laid].map(([k, v]) => [k, v.at.x, v.at.y, v.column])).toEqual([
      ['a', 38, 114, 'a'], ['b', 38, 157, 'a'], ['c', 38, 199, 'a'],
    ]);
  });

  it('the backend\'s target chain links at the join radius\'s number, in canvas units at zoom 1 (r24 Q2)', () => {
    // The tab joins columns at radiusPx screen px at any zoom; the backend's
    // chain (canvas units, zoom 1) only decides arrival. Same number, so at
    // zoom 1 they agree.
    const backend = readFileSync(resolve(__dirname, '../../backend/services/agent_presence.py'), 'utf8');
    expect(Number(backend.match(/^ARRIVAL_RADIUS = ([\d.]+)$/m)![1])).toBe(AGENT_CURSOR_STACK.radiusPx);
  });

  it('review 9\'s minimal example: b stays on its node at 120 when d\'s arrival joins the columns (r23 item 1)', () => {
    const list = [entry('a', 0, 0, 1), entry('b', 0, 120, 2), entry('c', 0, 0, 3), entry('d', 0, 0, 4)];
    const laid = deStackLayout(list, 1);
    expectColumnsCapped(list, laid, 1);
    expect(laid.get('b')!.at).toEqual({ x: 0, y: 120 });
  });

  it('ex4 (review 8\'s fuzz): the head of a joined stack is never the count cursor', () => {
    const rows = [['a', 8, 93.6], ['b', 0, 205.7], ['c', 0, 194.2], ['d', 4, 211.3], ['e', 4, 97.1], ['f', 4, 129.6]] as const;
    const list = rows.map(([k, x, y], i) => entry(k, x, y, i + 1));
    const laid = deStackLayout(list, 1);
    const columns = expectColumnsCapped(list, laid);
    for (const members of columns.values()) {
      if (members.length > 1) expect(laid.get(members[0].key)!.group).toBeUndefined();
    }
  });

  it('a target on another cursor\'s name pill, to the right, joins that column', () => {
    const spots = deStack([entry('a', 0, 0, 1), entry('b', 40, 12, 2)], 1);
    expect(spots.get('b')).toEqual({ x: 0, y: S });
  });

  it('a chain that splits re-lays every cursor that must move: a middle member gone, the last one still meets the head', () => {
    const three = deStackLayout([entry('a', 0, 0, 1), entry('b', 15, 0, 2), entry('c', 30, 0, 3)], 1);
    expect(three.get('c')!.at).toEqual({ x: 0, y: 2 * S });
    const two = deStackLayout([entry('a', 0, 0, 1), entry('c', 30, 0, 3)], 1);
    // 30 px from a's target, but its arrow would sit on a's name pill.
    expect(two.get('c')!.at).toEqual({ x: 0, y: S });
    // A changed layout, which the layer glides (review 6, item 2).
    expect(two.get('c')!.sig).not.toBe(three.get('c')!.sig);
  });

  it('names what put each cursor on its spot: the same under a zoom or a ride, changed by a say, a join or a leave', () => {
    const base = [entry('a', 0, 0, 1), entry('b', 4, 3, 2), entry('c', 0, 0, 3)];
    const sigs = (list: typeof base, zoom: number) => [...deStackLayout(list, zoom).values()].map((s) => s.sig);
    const rest = sigs(base, 1);
    expect(rest[0]).toBe('');
    expect(sigs(base, 0.6)).toEqual(rest);
    expect(sigs(base.map((e) => ({ ...e, target: { x: e.target.x + 37, y: e.target.y - 12 } })), 1)).toEqual(rest);
    expect(sigs(base.map((e, i) => (i === 0 ? { ...e, say: true } : e)), 1)).not.toEqual(rest);
    expect(sigs([base[0], base[2]], 1)[1]).not.toBe(rest[2]);
    expect(deStackLayout(base, 1).get('c')!.above).toEqual(['a', 'b']);
  });

  it('fuzz: random targets, arrival orders, says and zooms: no two drawn cursors closer than 2 px, no arrow by a foreign label', () => {
    const rand = seeded(211_6);
    let pairs = 0;
    let columnPairs = 0;
    for (let round = 0; round < 200; round += 1) {
      const zoom = [0.25, 0.5, 0.8, 1, 1.5, 2, 3][Math.floor(rand() * 7)];
      const count = 2 + Math.floor(rand() * 6);
      const list = Array.from({ length: count }, (_, i) => entry(
        String.fromCharCode(97 + i),
        // In a box about 120 screen px wide, so they meet often.
        (rand() * 120) / zoom,
        (rand() * 120) / zoom,
        Math.floor(rand() * 1000),
        rand() < 0.4,
      ));
      const laid = deStackLayout(list, zoom);
      // Folded cursors aren't drawn: their count cursor is.
      const drawn = list.filter((e) => !laid.get(e.key)!.collapsedInto);
      // Grouped by the layout's real column (review 8: `above[0]` split a
      // merged column in two).
      const head = (key: string) => laid.get(key)!.column!;
      const screen = drawn.map((e) => ({ key: e.key, at: { x: laid.get(e.key)!.at.x * zoom, y: laid.get(e.key)!.at.y * zoom }, say: Boolean(e.say) }));
      for (let i = 0; i < screen.length; i += 1) {
        for (let j = i + 1; j < screen.length; j += 1) {
          const [p, q] = [screen[i], screen[j]];
          // In one column every say counts; across columns a say pill
          // never moves anyone (r17 item 2): the layer moves it aside or
          // holds it, so arrows and names only.
          const own = head(p.key) === head(q.key);
          if (own) columnPairs += 1;
          const [sp, sq] = own ? [p.say, q.say] : [false, false];
          expect(paintedGap(p.at, sp, q.at, sq, true)).toBeGreaterThanOrEqual(2 - 0.05);
          expect(ownsArrowOf(p.at, sp, q.at)).toBe(false);
          expect(ownsArrowOf(q.at, sq, p.at)).toBe(false);
          pairs += 1;
        }
      }
      expectColumnsCapped(list, laid, zoom);
      expectColumnsJustified(list, laid, zoom);
    }
    expect(pairs).toBeGreaterThan(300);
    expect(columnPairs).toBeGreaterThan(100);
  }, 60_000);

  it.each([0.25, 0.5, 1, 2, 3])('a column of 4 to 8 at zoom %s draws 3: two in full, then one count cursor for the rest, never more than 2 steps down (GM r17 item 1)', (zoom) => {
    for (let n = 4; n <= 8; n += 1) {
      for (const says of [false, true]) {
        const keys = Array.from({ length: n }, (_, i) => String.fromCharCode(97 + i));
        const laid = deStackLayout(keys.map((key, i) => entry(key, 50, 50, i + 1, says)), zoom);
        const step = stackStepPx(says) / zoom;
        const y = (key: string) => laid.get(key)!.at.y;
        expect(laid.get('a')!.at).toEqual({ x: 50, y: 50 });
        expect(y('b')).toBeCloseTo(50 + step, 9);
        // The third slot is the count cursor; the latest arrivals fold into it.
        expect(y('c')).toBeCloseTo(50 + 2 * step, 9);
        expect(laid.get('c')!.group).toEqual(keys.slice(2));
        for (const key of keys.slice(3)) {
          expect(laid.get(key)!.collapsedInto).toBe('c');
          expect(laid.get(key)!.at).toEqual(laid.get('c')!.at);
        }
        for (const spot of laid.values()) expect((spot.at.y - 50) * zoom).toBeLessThanOrEqual(2 * stackStepPx(true) + 1e-6);
        expect(countLabel(laid.get('c')!.group!.length)).toBe(`${n - 2} more`);
      }
    }
    // Three: all in full, no count.
    const three = deStackLayout(['a', 'b', 'c'].map((key, i) => entry(key, 0, 0, i + 1)), zoom);
    expect([...three.values()].every((spot) => !spot.group && !spot.collapsedInto)).toBe(true);
  });

  it('a column opening back up: a member leaves and the count cursor is three full cursors again, the folded one at its slot', () => {
    const four = deStackLayout(['a', 'b', 'c', 'd'].map((key, i) => entry(key, 0, 0, i + 1)), 1);
    expect(four.get('d')!.collapsedInto).toBe('c');
    const three = deStackLayout(['a', 'c', 'd'].map((key) => entry(key, 0, 0, key.charCodeAt(0))), 1);
    // c glides up a step; d opens where the count cursor was.
    expect(three.get('c')!.at).toEqual({ x: 0, y: S });
    expect(three.get('d')!.at).toEqual(four.get('c')!.at);
    expect(three.get('d')!.collapsedInto).toBeUndefined();
  });

  it('a say pill never makes a join or moves another column: only a target within 16 px or an arrow by a name pill does (GM r17 item 2)', () => {
    // b's arrow under a's say pill, clear of a's name: it stays on its target.
    const spots = deStack([entry('a', 0, 0, 1, true), entry('b', 60, 46, 2)], 1);
    expect(spots.get('b')).toEqual({ x: 60, y: 46 });
    expect(targetsMeet(entry('a', 0, 0, 1, true), entry('b', 60, 46, 2), 1)).toBe(false);
    // The same arrow by a's name pill joins, say or not.
    for (const say of [false, true]) expect(deStack([entry('a', 0, 0, 1, say), entry('b', 40, 12, 2)], 1).get('b')).toEqual({ x: 0, y: stackStepPx(say) });
    // A later cursor whose say pill would reach an earlier one's arrow
    // stays where it is: its say moves aside instead (the layer).
    const late = deStack([entry('a', 120, 30, 1), entry('b', 0, 0, 2, true)], 1);
    expect(late.get('b')).toEqual({ x: 0, y: 0 });
    expect(late.get('a')).toEqual({ x: 120, y: 30 });
  });

  it('a say flipped to the left of its arrow: its right edge 4 px left of the tip, on the say row', () => {
    const tip = AGENT_CURSOR_ARROW_POINTS[0];
    const left = cursorShape({ x: 100, y: 100 }, 'left', 64, 120);
    const box = sayPillBox(left)!;
    expect(box.right).toBeCloseTo(100 + tip.x - AGENT_CURSOR_SAY_LEFT_GAP_PX, 9);
    expect(box.right - box.left).toBeCloseTo(120, 9);
    const right = sayPillBox(cursorShape({ x: 100, y: 100 }, true, 64, 120))!;
    expect(box.top).toBe(right.top);
    expect(right.left).toBe(100 + AGENT_CURSOR_PILL.left);
    expect(left.bounds.left).toBeCloseTo(box.left, 9);
    expect(left.bounds.bottom).toBe(right.bottom);
    // The CSS puts it there: the label is 15 px in, the tip 1.5 px.
    const css = readFileSync(resolve(__dirname, '../src/styles/agentCursor.css'), 'utf8');
    const rule = css.match(/^\.agent-cursor\[data-say-side='left'\] \.agent-cursor__say \{([^}]*)\}/m)![1];
    expect(rule).toMatch(new RegExp(`right: calc\\(100% \\+ ${AGENT_CURSOR_PILL.left - tip.x + AGENT_CURSOR_SAY_LEFT_GAP_PX}px\\);`));
    expect(rule).toMatch(new RegExp(`top: ${AGENT_CURSOR_PILL.height + AGENT_CURSOR_PILL.gap}px;`));
  });

  it('measures pill widths without a layout read: on the wide side, the say pill at most 260 px', () => {
    const { nameW, sayW } = labelWidths('Claude · 2', 'Checking the prompt');
    expect(nameW).toBeGreaterThanOrEqual(14 + 'Claude · 2'.length * 5);
    expect(sayW).toBeGreaterThanOrEqual(18 + 'Checking the prompt'.length * 5);
    expect(labelWidths('x', 'y'.repeat(400)).sayW).toBe(260);
    expect(labelWidths('x', undefined).sayW).toBe(0);
  });

  it('measures with the canvas where there is one: its font, 0.01em letter-spacing on top, padding and 2 px on the wide side (review 7, LOW-2 M2/M3)', () => {
    const fonts: string[] = [];
    class StubCanvas {
      getContext() {
        return {
          font: '',
          measureText(this: { font: string }, text: string) {
            fonts.push(this.font);
            return { width: text.length * 6.5 };
          },
        };
      }
    }
    vi.stubGlobal('OffscreenCanvas', StubCanvas);
    try {
      const name = 'Claude · 2';
      const say = 'Checking the prompt';
      const w = labelWidths(name, say);
      expect(w.nameW).toBe(Math.ceil(name.length * 6.5 + 0.11 * name.length + 14 + 2));
      expect(w.sayW).toBe(Math.ceil(say.length * 6.5 + 0.11 * say.length + 18 + 2));
      expect(fonts).toEqual([
        '600 11px Inter, "Helvetica Neue", Helvetica, Arial, sans-serif',
        '500 11px Inter, "Helvetica Neue", Helvetica, Arial, sans-serif',
      ]);
      expect(AGENT_CURSOR_NAME_FONT).toBe('600 11px Inter');
      expect(AGENT_CURSOR_SAY_FONT).toBe('500 11px Inter');
    } finally {
      vi.unstubAllGlobals();
    }
    // Without one: the estimate again.
    expect(labelWidths('abcd', '').nameW).toBe(4 * 7 + 16);
  });

  it('a leaving cursor whose name a live one shows hides its pill at once (PR #211 review 4), and none is promoted from CSS', () => {
    const css = readFileSync(resolve(__dirname, '../src/styles/agentCursor.css'), 'utf8');
    const rule = css.match(/^\.agent-cursor\[data-taken='true'\] \.agent-cursor__label \{([^}]*)\}/m);
    expect(rule?.[1]).toMatch(/visibility: hidden;/);
    expect(rule?.[1]).not.toMatch(/transition/);
    // will-change comes from the layer, only while a cursor flies (r10 item 1).
    expect(css).not.toMatch(/will-change\s*:/);
  });

  it('a leaving cursor\'s pills run no curve of their own: no transition, and a say fade stops where it is (review 5, M1)', () => {
    const css = readFileSync(resolve(__dirname, '../src/styles/agentCursor.css'), 'utf8');
    const still = css.match(/^\.agent-cursor\[data-leaving='true'\] \.agent-cursor__label,\n\.agent-cursor\[data-leaving='true'\] \.agent-cursor__name \{([^}]*)\}/m);
    expect(still?.[1]).toMatch(/transition: none;/);
    const say = css.match(/^\.agent-cursor\[data-leaving='true'\] \.agent-cursor__say \{([^}]*)\}/m);
    expect(say?.[1]).toMatch(/animation-play-state: paused;/);
  });

  it("the pill box matches agentCursor.css: the label's offset and the pill's height", () => {
    const css = readFileSync(resolve(__dirname, '../src/styles/agentCursor.css'), 'utf8');
    const label = css.match(/^\.agent-cursor__label \{([^}]*)\}/m)![1];
    expect(label).toMatch(new RegExp(`left: ${AGENT_CURSOR_PILL.left}px;`));
    expect(label).toMatch(new RegExp(`top: ${AGENT_CURSOR_PILL.top}px;`));
    const pill = css.match(/^\.agent-cursor__name \{([^}]*)\}/m)![1];
    const pad = Number(pill.match(/padding: (\d+)px/)![1]);
    const line = Number(pill.match(/line-height: (\d+)px/)![1]);
    expect(line + 2 * pad).toBe(AGENT_CURSOR_PILL.height);
    expect(pill).toMatch(/border-radius: 999px;/); // round ends
    expect(label).toMatch(new RegExp(`gap: ${AGENT_CURSOR_PILL.gap}px;`));
    const say = css.match(/^\.agent-cursor__say \{([^}]*)\}/m)![1];
    expect(Number(say.match(/line-height: (\d+)px/)![1]) + 2 * Number(say.match(/padding: (\d+)px/)![1])).toBe(AGENT_CURSOR_PILL.height);
    expect(say).toMatch(/border-radius: 999px;/);
    // The arrow's stroke, and the ring on an edge fill.
    expect(css).toMatch(new RegExp(`stroke-width: ${AGENT_CURSOR_ARROW_STROKE};`));
    expect(css).toMatch(new RegExp(`box-shadow: 0 0 0 ${AGENT_CURSOR_PILL.ring}px rgb`));
  });

  it('paints the most recently active cursor on top (last)', () => {
    expect(paintOrder([
      { key: 'new', receivedAt: 30 },
      { key: 'old', receivedAt: 10 },
      { key: 'mid', receivedAt: 20 },
    ])).toEqual(['old', 'mid', 'new']);
  });
});

describe('the name pill edge (GM - Design, PR #211 r9 item 4)', () => {
  it('pins the rule: under 3:1 on the canvas, Slava #000 and classic #111', () => {
    expect(AGENT_CURSOR_PILL_EDGE).toEqual({ minContrast: 3, slavaCanvas: '#000000', classicCanvas: '#111111' });
  });

  it('takes the edge just under 3:1 and not at 3:1 or over, on each canvas', () => {
    // On #000: #595959 is 2.998:1, #5a5a5a 3.045:1.
    expect(contrastRatio('#595959', '#000000')).toBeLessThan(3);
    expect(pillEdge('#595959')).toBe('both');
    expect(contrastRatio('#5a5a5a', '#000000')).toBeGreaterThanOrEqual(3);
    // On #111: #5f5f5f is 2.957:1, #606060 3.003:1.
    expect(pillEdge('#5a5a5a')).toBe('classic');
    expect(pillEdge('#5f5f5f')).toBe('classic');
    expect(contrastRatio('#606060', '#111111')).toBeGreaterThanOrEqual(3);
    expect(pillEdge('#606060')).toBeNull();
  });

  it('black keeps L 0.35, and its pills take the edge in both skins; Claude and white need none', () => {
    const black = [1, 2, 3, 4, 5].map((ordinal) => sessionFill('#000000', { key: 'k', ordinal }));
    expect(black[0]).toBe('#3a3a3a');
    expect(black.map(pillEdge)).toEqual(['both', 'both', null, null, null]);
    expect(pillEdge(sessionFill('#E8825A', { key: 'k', ordinal: 1 }))).toBeNull();
    expect(pillEdge(sessionFill('#ffffff', { key: 'k', ordinal: 1 }))).toBeNull();
  });

  it('the edge is a 1 px white 0.4 ring outside the pill, on #000 in both skins and on #111 in the classic one only', () => {
    const css = readFileSync(resolve(__dirname, '../src/styles/agentCursor.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const rule = css.match(/([^{}]+)\{\s*box-shadow:\s*0 0 0 1px rgb\(255 255 255 \/ 0\.4\)[^}]*\}/);
    expect(rule).not.toBeNull();
    const selectors = rule![1].split(',').map((part) => part.trim().replace(/\s+/g, ' '));
    expect(selectors).toEqual([
      ".agent-cursor[data-edge='both'] .agent-cursor__name",
      "body:not(.app-slava-restraint) .agent-cursor[data-edge='classic'] .agent-cursor__name",
    ]);
  });
});

describe('the target chain (GM - Design, #219 r24 Q2, r47 Q1)', () => {
  it('runs the shared fixture the backend runs too, with the same chains', () => {
    type T = { x: number; y: number } | { node: { x: number; y: number; width: number; height: number } };
    const fixture = JSON.parse(readFileSync(resolve(__dirname, '../../backend/tests/fixtures/cursor_chains.json'), 'utf8')) as {
      cases: { name: string; targets: Record<string, T>; chains: Record<string, string[]> }[];
    };
    expect(fixture.cases.length).toBeGreaterThanOrEqual(8);
    for (const c of fixture.cases) {
      const points = new Map(Object.entries(c.targets).map(([k, t]) => [k,
        'node' in t ? nodeHeaderPoint(t.node.x, t.node.y, t.node.width, t.node.height) : { x: t.x, y: t.y }]));
      const chains = Object.fromEntries([...targetChains(points)].map(([k, v]) => [k, [...v].sort()]));
      expect(chains, c.name).toEqual(c.chains);
    }
  });

  it('tells chains apart by who is in them', () => {
    expect(sameChain(new Set(['a', 'b']), new Set(['b', 'a']))).toBe(true);
    expect(sameChain(new Set(['a']), new Set(['a', 'b']))).toBe(false);
    expect(sameChain(new Set(['a', 'c']), new Set(['a', 'b']))).toBe(false);
    expect(sameChain(new Set(), new Set())).toBe(true);
  });
});
