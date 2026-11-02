import { describe, expect, it } from 'vitest';
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
  pillEdge,
} from '../src/lib/agentCursorLook';

/** GM - Design's agent cursor spec, §1 (the name's ink) and §4 (names, say, several agents). */

// The runners' colours and the palette unverified agents hash into (backend services/agent_presence.py).
const CLAUDE = '#E8825A';
const CODEX = '#5B9DFF';
const PALETTE = ['#3FC1A5', '#F2C14E', '#FF6B9A', '#7AD3FF', '#C3E86B', '#FF9F43'];
const BUILT_IN = [CLAUDE, CODEX, ...PALETTE];

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
function paintedGap(i: P, sayI: boolean, j: P, sayJ: boolean): number {
  let least = Infinity;
  for (const [a, b, sb] of [[i, j, sayJ], [j, i, sayI]] as [P, P, boolean][]) {
    for (const pill of pillsAt(b, sb)) least = Math.min(least, gap(pill, arrowAt(a)));
  }
  for (const p of pillsAt(i, sayI)) for (const q of pillsAt(j, sayJ)) least = Math.min(least, gap(p, q));
  return least;
}

describe('no stacking (GM - Design, PR #211 r12 and r13)', () => {
  it('steps straight down by the smallest step with 2 px clear: 24 below a name, 47 below a name and a say', () => {
    expect(stackStepPx(false)).toBe(24);
    expect(stackStepPx(true)).toBe(47);
    for (const say of [false, true]) {
      const step = stackStepPx(say);
      // Measured apart from the module: 2 px clear at the step, less one px above it.
      expect(paintedGap({ x: 0, y: 0 }, say, { x: 0, y: step }, false)).toBeGreaterThanOrEqual(2 - 0.02);
      expect(paintedGap({ x: 0, y: 0 }, say, { x: 0, y: step - 1 }, false)).toBeLessThan(2);
      expect(stackClearancePx(step, say)).toBeGreaterThanOrEqual(AGENT_CURSOR_STACK.clearPx);
      expect(stackClearancePx(step - 1, say)).toBeLessThan(AGENT_CURSOR_STACK.clearPx);
    }
  });

  it('measures the arrow the layer draws', () => {
    expect(AGENT_CURSOR_ARROW_POINTS).toEqual(ARROW);
    expect(AGENT_CURSOR_ARROW_PATH).toBe(`M${ARROW.map((p) => `${p.x} ${p.y}`).join(' L')} Z`);
    const layer = readFileSync(resolve(__dirname, '../src/components/canvas/AgentCursorLayer.tsx'), 'utf8');
    expect(layer).toMatch(/<path d=\{AGENT_CURSOR_ARROW_PATH\} \/>/);
  });

  it('lands a later cursor straight below an earlier one within 16 px, never to the right', () => {
    const spots = deStack([
      { key: 'b', target: { x: 105, y: 100 }, since: 2 },
      { key: 'a', target: { x: 100, y: 100 }, since: 1 },
    ], 1);
    expect(spots.get('a')).toEqual({ x: 100, y: 100 });
    expect(spots.get('b')).toEqual({ x: 100, y: 124 });
  });

  it('leaves cursors more than 16 px apart where they are', () => {
    const spots = deStack([
      { key: 'a', target: { x: 100, y: 100 }, since: 1 },
      { key: 'b', target: { x: 116.5, y: 100 }, since: 2 },
    ], 1);
    expect(spots.get('b')).toEqual({ x: 116.5, y: 100 });
  });

  it('steps past the earlier label block: name, plus the say pill while one shows', () => {
    const at = (say: boolean[]) => [...deStack(say.map((s, i) => ({
      key: String(i), target: { x: 0, y: 0 }, since: i + 1, say: s,
    })), 1).values()];
    expect(at([false, false, false])).toEqual([{ x: 0, y: 0 }, { x: 0, y: 24 }, { x: 0, y: 48 }]);
    expect(at([false, true, false])).toEqual([{ x: 0, y: 0 }, { x: 0, y: 24 }, { x: 0, y: 71 }]);
    expect(at([true, false, false])).toEqual([{ x: 0, y: 0 }, { x: 0, y: 47 }, { x: 0, y: 71 }]);
  });

  it('never lands on an earlier tip: one aimed up-left of it joins its column (review 1, F1)', () => {
    const spots = deStack([
      { key: 'a', target: { x: 0, y: 0 }, since: 1 },
      { key: 'b', target: { x: -10, y: -10 }, since: 2 },
    ], 1);
    expect(spots.get('a')).toEqual({ x: 0, y: 0 });
    expect(spots.get('b')).toEqual({ x: 0, y: 24 });
  });

  it('joining is transitive: a chain of near targets is one column, ordered by arrival (review 5, M2)', () => {
    const spots = deStack([
      { key: 'a', target: { x: 0, y: 0 }, since: 1 },
      { key: 'c', target: { x: 10, y: 10 }, since: 2 },
      { key: 'b', target: { x: 0, y: 0 }, since: 3 },
      // Near only the second cursor's tip (0, 24), not the first's.
      { key: 'd', target: { x: 6, y: 30 }, since: 4 },
    ], 1);
    expect([...spots.entries()]).toEqual([
      ['a', { x: 0, y: 0 }], ['c', { x: 0, y: 24 }], ['b', { x: 0, y: 48 }], ['d', { x: 0, y: 72 }],
    ]);
  });

  it('orders by when each came to its spot, not by its last event (review 1, F2)', () => {
    const spots = deStack([
      { key: 'b', target: { x: 0, y: 0 }, since: 2 },
      { key: 'a', target: { x: 0, y: 0 }, since: 1 },
    ], 1);
    expect(spots.get('a')).toEqual({ x: 0, y: 0 });
    expect(spots.get('b')).toEqual({ x: 0, y: 24 });
  });

  it('measures in screen px at any zoom', () => {
    // At zoom 2, 10 flow px is 20 screen px: not stacked. 5 flow px is 10:
    // stacked, a step of 12 flow px down.
    expect(deStack([
      { key: 'a', target: { x: 0, y: 0 }, since: 1 },
      { key: 'b', target: { x: 10, y: 0 }, since: 2 },
    ], 2).get('b')).toEqual({ x: 10, y: 0 });
    expect(deStack([
      { key: 'a', target: { x: 0, y: 0 }, since: 1 },
      { key: 'b', target: { x: 5, y: 0 }, since: 2 },
    ], 2).get('b')).toEqual({ x: 0, y: 12 });
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
    for (let dx = -16; dx <= 16; dx += 1) {
      for (let dy = -16; dy <= 16; dy += 1) {
        const d = Math.hypot(dx, dy);
        if (d >= 9 && d <= 16) aims.push({ x: dx, y: dy });
      }
    }
    let checked = 0;
    for (const aim of aims) {
      for (const sayA of [false, true]) {
        const spots = deStack([
          { key: 'a', target: { x: 0, y: 0 }, since: 1, say: sayA },
          { key: 'b', target: aim, since: 2 },
          // A third aimed back the other way from the second.
          { key: 'c', target: { x: -aim.y / 2, y: aim.x / 2 }, since: 3 },
        ], 1);
        const [a, b, c] = ['a', 'b', 'c'].map((k) => spots.get(k)!);
        expect(b).toEqual({ x: 0, y: stackStepPx(sayA) });
        expect(c.x).toBe(0);
        expect(paintedGap(a, sayA, b, false)).toBeGreaterThanOrEqual(2 - 0.02);
        expect(paintedGap(b, false, c, false)).toBeGreaterThanOrEqual(2 - 0.02);
        expect(paintedGap(a, sayA, c, false)).toBeGreaterThanOrEqual(2 - 0.02);
        checked += 1;
      }
    }
    expect(checked).toBe(aims.length * 2);
  }, 30_000);

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
