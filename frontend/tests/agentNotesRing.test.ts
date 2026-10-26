// @vitest-environment node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { HEADER_BACKDROP, unreadRingColor } from '../src/lib/unreadRing';

/**
 * The Updates chip's unread ring is drawn in the newest unread author's
 * colour (one rule since the corner was built). Author colours come from
 * agents (any #RRGGBB), so the ring has GM's floor: at least 3:1 against the
 * header, the focus ring's bar. A colour under it is drawn as a lighter tint
 * of itself, never another colour; the dots in the chip stay as they are.
 */
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
const css = (file: string) => readFileSync(path.join(SRC, file), 'utf8');
type RGB = [number, number, number];
const hex = (value: string): RGB => [1, 3, 5].map((i) => parseInt(value.slice(i, i + 2), 16)) as RGB;
const luminance = ([r, g, b]: RGB) => {
  const lin = (c: number) => { const s = c / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};
const contrast = (a: RGB, b: RGB) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

describe('the unread ring on the header', () => {
  it('measures against the header the CSS draws: --sr-glass over --sr-canvas', () => {
    const tokens = css('styles/slava-restraint.css');
    const canvas = hex(tokens.match(/--sr-canvas:\s*(#[0-9a-f]{6})/i)![1]);
    const glass = tokens.match(/--sr-glass:\s*rgba\(([\d.]+),\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)\)/)!.slice(1).map(Number);
    const drawn = [0, 1, 2].map((i) => glass[i] * glass[3] + canvas[i] * (1 - glass[3]));
    drawn.forEach((channel, i) => expect(Math.abs(channel - HEADER_BACKDROP[i])).toBeLessThan(0.5));
  });

  it("keeps every built-in author colour as it is (they all clear 3:1)", () => {
    // backend/services/agent_presence.py: _KNOWN_AGENTS and _EXTERNAL_COLORS.
    for (const colour of ['#E8825A', '#5B9DFF', '#3FC1A5', '#F2C14E', '#FF6B9A', '#7AD3FF', '#C3E86B', '#FF9F43']) {
      expect(contrast(hex(colour), HEADER_BACKDROP)).toBeGreaterThanOrEqual(3);
      expect(unreadRingColor(colour)).toBe(colour);
    }
  });

  it('draws a dark author colour as a lighter tint of itself that clears 3:1', () => {
    for (const colour of ['#3A1F5C', '#102030', '#000000', '#5A1010']) {
      const ring = unreadRingColor(colour);
      expect(ring).not.toBe(colour);
      expect(contrast(hex(ring), HEADER_BACKDROP)).toBeGreaterThanOrEqual(3);
      const [r0, g0, b0] = hex(colour);
      const [r, g, b] = hex(ring);
      // A tint: every channel moves toward white by the same share.
      const shares = [[r0, r], [g0, g], [b0, b]].filter(([from]) => from < 255).map(([from, to]) => (to - from) / (255 - from));
      for (const share of shares) expect(Math.abs(share - shares[0])).toBeLessThan(0.02);
    }
  });

  it('leaves anything that is not a #RRGGBB colour alone', () => {
    expect(unreadRingColor('')).toBe('');
    expect(unreadRingColor('var(--an-ink)')).toBe('var(--an-ink)');
  });

  it('is what the ring draws: the chip sets --an-ring and the ring uses it', () => {
    expect(css('components/agent-notes/agentNotes.css')).toMatch(/\.agent-notes-chip::after\s*\{[^}]*border:\s*2px solid var\(--an-ring/);
    expect(css('components/agent-notes/AgentNotesCorner.tsx')).toMatch(/'--an-ring':\s*unreadRingColor\(newest\)/);
  });
});
