import { describe, expect, it } from 'vitest';
import {
  AGENT_CURSOR_INK_BLACK,
  AGENT_CURSOR_INK_DARK,
  AGENT_CURSOR_INK_LIGHT,
  AGENT_CURSOR_NAME_FIRST_SIGHT_MS,
  AGENT_CURSOR_SESSION_LIGHTNESS,
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
  });

  it("keeps the agent's colour exactly for its first session", () => {
    expect(sessionFill(CLAUDE, null)).toBe(CLAUDE);
    expect(sessionFill(CLAUDE, { ordinal: 1 })).toBe(CLAUDE);
    expect(sessionFill('not a colour', { ordinal: 2 })).toBe('not a colour');
  });

  it('steps OKLCH lightness 0, +0.10, −0.10, +0.18 and repeats, in the same hue', () => {
    for (const color of BUILT_IN) {
      const base = hexToOklch(color)!;
      for (let ordinal = 1; ordinal <= 9; ordinal += 1) {
        const fill = sessionFill(color, { ordinal });
        expect(fill, `${color} #${ordinal}`).toMatch(/^#[0-9a-fA-F]{6}$/);
        const got = hexToOklch(fill)!;
        const delta = AGENT_CURSOR_SESSION_LIGHTNESS[(ordinal - 1) % 4];
        const want = Math.min(1, Math.max(0, base.l + delta));
        expect(Math.abs(got.l - want), `${color} #${ordinal} L`).toBeLessThan(0.006);
        if (got.c > 0.03) expect(hueGap(got.h, base.h), `${color} #${ordinal} hue`).toBeLessThan(2);
      }
      expect(sessionFill(color, { ordinal: 5 })).toBe(sessionFill(color, { ordinal: 1 }));
      expect(sessionFill(color, { ordinal: 6 })).toBe(sessionFill(color, { ordinal: 2 }));
    }
    // Two Claude sessions look like Claude, and like two.
    expect(sessionFill(CLAUDE, { ordinal: 2 })).not.toBe(CLAUDE);
  });

  it('always returns a valid colour, lowering chroma to stay in sRGB', () => {
    const rand = seeded(7);
    for (let i = 0; i < 200; i += 1) {
      const color = randomHex(rand);
      for (let ordinal = 1; ordinal <= 4; ordinal += 1) expect(sessionFill(color, { ordinal })).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
    expect(sessionFill('#ffffff', { ordinal: 2 })).toBe('#ffffff');
  });
});

describe('the name rule', () => {
  const base = { moving: false, peers: 1, hovered: false, sinceFirstSightMs: 10_000 };
  it('hides the name while the cursor moves, whatever else holds', () => {
    expect(nameVisible({ moving: true, peers: 3, hovered: true, sinceFirstSightMs: 0 })).toBe(false);
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
      { key: 'b', target: { x: 105, y: 100 }, receivedAt: 2 },
      { key: 'a', target: { x: 100, y: 100 }, receivedAt: 1 },
    ], 1);
    expect(spots.get('a')).toEqual({ x: 100, y: 100 });
    expect(spots.get('b')).toEqual({ x: 115, y: 110 });
  });

  it('leaves cursors 16 px or more apart where they are', () => {
    const spots = deStack([
      { key: 'a', target: { x: 100, y: 100 }, receivedAt: 1 },
      { key: 'b', target: { x: 116, y: 100 }, receivedAt: 2 },
    ], 1);
    expect(spots.get('b')).toEqual({ x: 116, y: 100 });
  });

  it('chains: a third on the same spot steps past both', () => {
    const spots = deStack([
      { key: 'a', target: { x: 0, y: 0 }, receivedAt: 1 },
      { key: 'b', target: { x: 0, y: 0 }, receivedAt: 2 },
      { key: 'c', target: { x: 0, y: 0 }, receivedAt: 3 },
    ], 1);
    expect(spots.get('b')).toEqual({ x: 10, y: 10 });
    expect(spots.get('c')).toEqual({ x: 20, y: 20 });
  });

  it('measures in screen px at any zoom', () => {
    // At zoom 2, 10 flow px is 20 screen px: not stacked. 5 flow px is 10: stacked, offset 5 flow px.
    expect(deStack([
      { key: 'a', target: { x: 0, y: 0 }, receivedAt: 1 },
      { key: 'b', target: { x: 10, y: 0 }, receivedAt: 2 },
    ], 2).get('b')).toEqual({ x: 10, y: 0 });
    expect(deStack([
      { key: 'a', target: { x: 0, y: 0 }, receivedAt: 1 },
      { key: 'b', target: { x: 5, y: 0 }, receivedAt: 2 },
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
