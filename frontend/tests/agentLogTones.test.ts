import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AGENT_CURSOR_SESSION_LIGHTNESS,
  AGENT_FALLBACK_COLOR,
  AGENT_LOG_SURFACE,
  agentLogTones,
  compositeOver,
  contrastRatio,
  readableTone,
  hexToOklch,
  sessionFill,
} from '../src/lib/agentCursorColor';
import { agentActionEntry } from '../src/store/agentLogStore';
import type { AgentPresenceEvent } from '../src/lib/wsClient';

// GM - Design, PR #211 r20: an Agent log line's dot and name take the
// cursor's own shade; the name text reads at least 4.5:1 on the log's
// surface, stepping to the nearest passing tone of the same hue if needed.

const root = resolve(__dirname, '..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

/** Every agent colour the app hands out: the backend's known agents and
 *  external palette, the settings picker's palette, and the log's fallback. */
const agentColours = (() => {
  const backend = read('../backend/services/agent_presence.py');
  const known = [...backend.matchAll(/"#([0-9A-Fa-f]{6})"/g)].map((m) => `#${m[1]}`);
  const picker = read('src/components/panels/settings/ConnectedApps.tsx').match(/AGENT_COLORS = \[([^\]]+)\]/)![1];
  const fromPicker = [...picker.matchAll(/'#([0-9A-Fa-f]{6})'/g)].map((m) => `#${m[1]}`);
  return [...new Set([...known, ...fromPicker, AGENT_FALLBACK_COLOR].map((c) => c.toUpperCase()))];
})();

/** Restraint's log surface: its panel glass over the black canvas, from the stylesheet. */
const restraintSurface = (() => {
  const css = read('src/styles/slava-restraint.css');
  const glass = css.match(/--sr-glass:\s*rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/)!;
  const canvas = css.match(/--sr-canvas:\s*#([0-9A-Fa-f]{6})/)![1];
  const under = [0, 2, 4].map((i) => parseInt(canvas.slice(i, i + 2), 16));
  return compositeOver({ rgb: [1, 2, 3].map((i) => Number(glass[i])), alpha: Number(glass[4]) }, under);
})();

// The app has one appearance, Restraint, which is dark (lib/skins). The
// guard also holds on a light surface, so a light appearance added later
// keeps it.
const surfaces = [['Restraint (dark)', AGENT_LOG_SURFACE], ['a light surface', '#ffffff']] as const;
// Every shade the ramp can produce: the offsets cycle after their count.
const ordinals = Array.from({ length: AGENT_CURSOR_SESSION_LIGHTNESS.length }, (_, i) => i + 1);

const event = (color: string, ordinal: number): AgentPresenceEvent => ({
  type: 'agentPresence',
  agent: { id: 'pair', name: 'Pair', color, verified: true },
  action: 'move',
  say: 'Checking the prompt',
  at: 1,
  session: { key: 'abcdef012345', ordinal },
} as AgentPresenceEvent);

describe('the Agent log in each cursor\'s own shade (r20)', () => {
  it('the log surface is Restraint\'s glass over the canvas, as the stylesheet draws it', () => {
    expect(AGENT_LOG_SURFACE).toBe(restraintSurface);
    expect(agentColours.length).toBeGreaterThanOrEqual(8);
  });

  // Review 8, NIT-1: Chrome stores the glass alpha in 8 bits (0.66 → 168)
  // and paints #0e0e10; the exact alpha would round to #0f0f10.
  it('the surface is what Chrome paints: 8-bit alpha, #0e0e10', () => {
    expect(AGENT_LOG_SURFACE).toBe('#0e0e10');
    expect(compositeOver({ rgb: [22, 22, 24], alpha: 0.66 }, [0, 0, 0])).toBe('#0e0e10');
    expect(compositeOver({ rgb: [255, 0, 0], alpha: 0.5 }, [0, 0, 255])).toBe('#80007f'); // 0.5 is stored as 128/255
    expect(compositeOver({ rgb: [10, 20, 30], alpha: 1 }, [200, 200, 200])).toBe('#0a141e');
  });

  // Review 8, NIT-2 and the shared fallback: a colour that is not #rrggbb
  // never reaches the page as itself.
  it('an invalid colour gives the shared fallback, in the log and on the cursor alike', () => {
    for (const bad of ['red', '#abc', '#12345g', '', 'url(x)']) {
      expect(readableTone(bad, AGENT_LOG_SURFACE)).toBe(readableTone(AGENT_FALLBACK_COLOR, AGENT_LOG_SURFACE));
      expect(agentLogTones(bad, { ordinal: 1 })).toEqual(agentLogTones(AGENT_FALLBACK_COLOR, { ordinal: 1 }));
      expect(agentLogTones(bad, { ordinal: 2 })).toEqual(agentLogTones(AGENT_FALLBACK_COLOR, { ordinal: 2 }));
    }
    // On a light surface the fallback steps to a darker tone of its hue.
    expect(readableTone('red', '#ffffff')).toBe(readableTone(AGENT_FALLBACK_COLOR, '#ffffff'));
    expect(readableTone('red', '#ffffff')).not.toBe(AGENT_FALLBACK_COLOR);
    // Both stores import the one constant; neither keeps its own copy.
    for (const store of ['src/store/agentLogStore.ts', 'src/store/agentPresenceStore.ts']) {
      const text = read(store);
      expect(text).toMatch(/AGENT_FALLBACK_COLOR/);
      expect(text).not.toMatch(/#E8825A/i);
    }
  });

  it.each(surfaces)('every agent colour × every shade on %s: the dot is the cursor\'s shade, the name reads 4.5:1 in the same hue', (_name, surface) => {
    let stepped = 0;
    for (const colour of agentColours) {
      for (const ordinal of ordinals) {
        const shade = sessionFill(colour, { ordinal });
        const { dot, name } = agentLogTones(colour, { ordinal }, surface);
        expect(dot).toBe(shade);
        expect(contrastRatio(name, surface)).toBeGreaterThanOrEqual(4.5);
        if (name !== dot) {
          stepped += 1;
          // Only a shade that misses steps, and it keeps its hue.
          expect(contrastRatio(dot, surface)).toBeLessThan(4.5);
          const a = hexToOklch(dot)!;
          const b = hexToOklch(name)!;
          if (a.c > 0.03 && b.c > 0.03) {
            const dh = Math.abs(Math.atan2(Math.sin(a.h - b.h), Math.cos(a.h - b.h)));
            expect(dh).toBeLessThan(0.08);
          }
        }
      }
    }
    // Ordinals past the ramp repeat its shades.
    for (const colour of agentColours) {
      expect(sessionFill(colour, { ordinal: ordinals.length + 1 })).toBe(sessionFill(colour, { ordinal: 1 }));
    }
    // Some shades do miss on the dark log (the darkest sessions), so the step is exercised.
    if (surface === AGENT_LOG_SURFACE) expect(stepped).toBeGreaterThan(0);
  });

  it('the line the log keeps: dot and name from the cursor\'s shade, for every colour and shade', () => {
    for (const colour of agentColours) {
      for (const ordinal of ordinals) {
        const entry = agentActionEntry(event(colour, ordinal))!;
        expect(entry.agent!.name).toBe(ordinal === 1 ? 'Pair' : `Pair · ${ordinal}`);
        expect(entry.agent!.color).toBe(sessionFill(colour, { ordinal }));
        expect(contrastRatio(entry.agent!.ink!, AGENT_LOG_SURFACE)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('a shade that misses keeps its dot; only its name steps, to the nearest passing tone', () => {
    // A dark session of a dark-ish base: the canvas shade misses 4.5:1 on the log.
    const colour = '#B392F0';
    const missing = ordinals.find((o) => contrastRatio(sessionFill(colour, { ordinal: o }), AGENT_LOG_SURFACE) < 4.5)!;
    expect(missing).toBeDefined();
    const { dot, name } = agentLogTones(colour, { ordinal: missing });
    expect(dot).toBe(sessionFill(colour, { ordinal: missing }));
    expect(name).not.toBe(dot);
    expect(contrastRatio(name, AGENT_LOG_SURFACE)).toBeGreaterThanOrEqual(4.5);
    // On the dark log it steps lighter, and only as far as it must: just
    // past 4.5:1, not to white.
    expect(hexToOklch(name)!.l).toBeGreaterThan(hexToOklch(dot)!.l);
    expect(contrastRatio(name, AGENT_LOG_SURFACE)).toBeLessThan(4.9);
  });

  it('random agent colours hold too', () => {
    let seed = 7;
    const rand = () => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed / 2 ** 31; };
    for (let i = 0; i < 300; i += 1) {
      const colour = `#${Math.floor(rand() * 0xffffff).toString(16).padStart(6, '0')}`;
      for (const ordinal of ordinals) {
        const { dot, name } = agentLogTones(colour, { ordinal });
        expect(dot).toBe(sessionFill(colour, { ordinal }));
        expect(contrastRatio(name, AGENT_LOG_SURFACE)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});
