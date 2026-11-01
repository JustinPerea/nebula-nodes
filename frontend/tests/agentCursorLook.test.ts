import { describe, expect, it } from 'vitest';
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
  hexToOklch,
  inkFor,
  labelLayout,
  nameVisible,
  paintOrder,
  sessionFill,
  sessionName,
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
    expect(AGENT_CURSOR_SESSION_BAND).toEqual({ max: 0.92, min: 0.35, minGap: 0.05 });
  });

  it('steps L by 0, −0.10, +0.10, −0.20, +0.20 in the band, mirrors past it, and cycles after five', () => {
    // Mid L: the plain offsets.
    expect([1, 2, 3, 4, 5].map((n) => +sessionLightness(0.6, n).toFixed(6))).toEqual([0.6, 0.5, 0.7, 0.4, 0.8]);
    const five = (L: number) => [1, 2, 3, 4, 5].map((n) => +sessionLightness(L, n).toFixed(6));
    // Light: +0.10 passes 0.92 and clamps to it (0.07 from 0.85); +0.20
    // clamps onto that same 0.92 and mirrors onto 0.65, which −0.20 took,
    // so the last steps on by 0.10 inside the band (GM - Design, PR #211 r7).
    expect(five(0.85)).toEqual([0.85, 0.75, 0.92, 0.65, 0.55]);
    // Dark: −0.10 falls under 0.35 and clamps to it (0.05 from 0.40); −0.20
    // clamps onto that same 0.35 and mirrors up to 0.60.
    expect(five(0.4)).toEqual([0.4, 0.35, 0.5, 0.6, 0.7]);
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

  it('clamps a step past the band to its edge before mirroring, on both sides (GM - Design, PR #211 r7)', () => {
    const five = (L: number) => [1, 2, 3, 4, 5].map((n) => +sessionLightness(L, n).toFixed(4));
    // The pink external colour (#FF6B9A, L 0.7226): +0.20 is 0.9226, past
    // 0.92 by 0.0026. Mirrored it would land on · 4's 0.5226, so · 5 went
    // darkest (0.4226). Clamped it sits at 0.92 and stays the lightest.
    const pink = hexToOklch('#FF6B9A')!.l;
    expect(pink).toBeCloseTo(0.7226, 4);
    expect(five(pink)).toEqual([0.7226, 0.6226, 0.8226, 0.5226, 0.92]);
    const fills = [1, 2, 3, 4, 5].map((ordinal) => sessionFill('#FF6B9A', { ordinal }));
    expect(fills).toEqual(['#FF6B9A', '#db4a7c', '#ffa8be', '#b8265f', '#ffd9e2']);
    const Ls = fills.map((f) => hexToOklch(f)!.l);
    expect(Math.max(...Ls)).toBe(Ls[4]);
    expect(Math.min(...Ls)).toBe(Ls[3]);
    // Low side: from 0.52, −0.20 is 0.32 and clamps to 0.35 (0.07 from · 2's 0.42).
    expect(five(0.52)).toEqual([0.52, 0.42, 0.62, 0.35, 0.72]);
    // The clamp needs 0.05 of room: from 0.47 the edge is 0.02 from · 2's
    // 0.37, so −0.20 mirrors to 0.67 and +0.20 steps on to 0.77.
    expect(five(0.47)).toEqual([0.47, 0.37, 0.57, 0.67, 0.77]);
    // The real Claude never reaches the edge: its five are the plain offsets.
    const claude = hexToOklch(CLAUDE)!.l;
    expect([1, 2, 3, 4, 5].map((n) => sessionLightness(claude, n) - claude).map((d) => +d.toFixed(6))).toEqual([0, -0.1, 0.1, -0.2, 0.2]);
    expect([1, 2, 3, 4, 5].map((ordinal) => sessionFill(CLAUDE, { ordinal }))).toEqual(['#E8825A', '#c6633b', '#ffa887', '#a4451b', '#ffd8c9']);
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

describe('no stacking', () => {
  it('lands a later cursor 10 px down-right of an earlier one within 16 px', () => {
    const spots = deStack([
      { key: 'b', target: { x: 105, y: 100 }, since: 2 },
      { key: 'a', target: { x: 100, y: 100 }, since: 1 },
    ], 1);
    expect(spots.get('a')).toEqual({ x: 100, y: 100 });
    expect(spots.get('b')).toEqual({ x: 115, y: 110 });
  });

  it('leaves cursors 16 px or more apart where they are', () => {
    const spots = deStack([
      { key: 'a', target: { x: 100, y: 100 }, since: 1 },
      { key: 'b', target: { x: 116, y: 100 }, since: 2 },
    ], 1);
    expect(spots.get('b')).toEqual({ x: 116, y: 100 });
  });

  it('chains: a third on the same spot steps past both', () => {
    const spots = deStack([
      { key: 'a', target: { x: 0, y: 0 }, since: 1 },
      { key: 'b', target: { x: 0, y: 0 }, since: 2 },
      { key: 'c', target: { x: 0, y: 0 }, since: 3 },
    ], 1);
    expect(spots.get('b')).toEqual({ x: 10, y: 10 });
    expect(spots.get('c')).toEqual({ x: 20, y: 20 });
  });

  it('never lands on an earlier tip: one aimed up-left of it steps past (review 1, F1)', () => {
    const spots = deStack([
      { key: 'a', target: { x: 0, y: 0 }, since: 1 },
      { key: 'b', target: { x: -10, y: -10 }, since: 2 },
    ], 1);
    expect(spots.get('a')).toEqual({ x: 0, y: 0 });
    expect(spots.get('b')).toEqual({ x: 10, y: 10 });
  });

  it('two later cursors never share a spot (review 1, F1)', () => {
    const spots = deStack([
      { key: 'a', target: { x: 0, y: 0 }, since: 1 },
      { key: 'c', target: { x: 10, y: 10 }, since: 2 },
      { key: 'b', target: { x: 0, y: 0 }, since: 3 },
    ], 1);
    expect(spots.get('a')).toEqual({ x: 0, y: 0 });
    expect(spots.get('c')).toEqual({ x: 10, y: 10 });
    expect(spots.get('b')).toEqual({ x: 20, y: 20 });
    const all = [...spots.values()];
    for (const p of all) for (const q of all) if (p !== q) expect(p.x === q.x && p.y === q.y).toBe(false);
  });

  it('orders by when each came to its spot, not by its last event (review 1, F2)', () => {
    // a came first; b's newer event doesn't push a aside.
    const spots = deStack([
      { key: 'a', target: { x: 0, y: 0 }, since: 1 },
      { key: 'b', target: { x: 0, y: 0 }, since: 2 },
    ], 1);
    expect(spots.get('a')).toEqual({ x: 0, y: 0 });
    expect(spots.get('b')).toEqual({ x: 10, y: 10 });
  });

  it('measures in screen px at any zoom', () => {
    // At zoom 2, 10 flow px is 20 screen px: not stacked. 5 flow px is 10: stacked, offset 5 flow px.
    expect(deStack([
      { key: 'a', target: { x: 0, y: 0 }, since: 1 },
      { key: 'b', target: { x: 10, y: 0 }, since: 2 },
    ], 2).get('b')).toEqual({ x: 10, y: 0 });
    expect(deStack([
      { key: 'a', target: { x: 0, y: 0 }, since: 1 },
      { key: 'b', target: { x: 5, y: 0 }, since: 2 },
    ], 2).get('b')).toEqual({ x: 10, y: 5 });
  });

  it('paints the most recently active cursor on top (last)', () => {
    expect(paintOrder([
      { key: 'new', receivedAt: 30 },
      { key: 'old', receivedAt: 10 },
      { key: 'mid', receivedAt: 20 },
    ])).toEqual(['old', 'mid', 'new']);
  });
});
