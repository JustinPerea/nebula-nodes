import { describe, expect, it } from 'vitest';
import type { Box } from '../src/lib/agentAnchorResolve';
import { chipName, countName, estimateChipWidth, planChips, type ChipCursor, type ChipSizes, type Obstacle } from '../src/lib/agentEdgeChips';
import { visiblePane } from '../src/lib/agentChipChrome';
import { AGENT_CURSOR_CHIP } from '../src/lib/agentCursorTuning';

/** PR #233 slice 9: where the canvas's edge chips go. */

const VIEW: Box = { left: 0, top: 0, width: 1000, height: 700 };
const SIZES: ChipSizes = { chip: () => ({ width: 100, height: 28 }), count: { width: 36, height: 20 } };
const { insetPx, gapPx } = AGENT_CURSOR_CHIP;
let n = 0;
const cur = (tip: { x: number; y: number }, over: Partial<ChipCursor> = {}): ChipCursor =>
  ({ key: `c${n += 1}`, label: 'Claude', color: '#E8825A', tip, activeAt: n, ...over });
const plan = (cursors: ChipCursor[], obstacles: Obstacle[] = [], view = VIEW) => planChips({ view, obstacles, cursors, sizes: SIZES });
const right = (b: Box) => b.left + b.width;
const bottom = (b: Box) => b.top + b.height;
const overlap = (a: Box, b: Box) => a.left < right(b) && b.left < right(a) && a.top < bottom(b) && b.top < bottom(a);

describe('placement at the pane\'s edges (12 px in, on the line from the middle to the tip)', () => {
  it('a cursor far to the left: the chip is 12 px inside the left edge, level with it', () => {
    const { chips } = plan([cur({ x: -2000, y: 350 })]);
    expect(chips).toHaveLength(1);
    expect(chips[0].side).toBe('left');
    expect(chips[0].box.left).toBe(insetPx);
    expect(chips[0].box.top + chips[0].box.height / 2).toBeCloseTo(350, 5);
    expect(Math.cos(chips[0].angle)).toBeLessThan(-0.99); // the chevron points left
  });

  it('right, above and below', () => {
    const r = plan([cur({ x: 3000, y: 350 })]).chips[0];
    expect(right(r.box)).toBe(VIEW.width - insetPx);
    expect(r.side).toBe('right');
    const t = plan([cur({ x: 500, y: -900 })]).chips[0];
    expect(t.box.top).toBe(insetPx);
    expect(t.side).toBe('top');
    expect(Math.sin(t.angle)).toBeLessThan(-0.99);
    const b = plan([cur({ x: 500, y: 2000 })]).chips[0];
    expect(bottom(b.box)).toBe(VIEW.height - insetPx);
    expect(b.side).toBe('bottom');
    expect(Math.sin(b.angle)).toBeGreaterThan(0.99);
  });

  it('the line from the middle decides where along the edge: a tip up and to the right lands on the right edge, above the middle', () => {
    const c = plan([cur({ x: 1500, y: 100 })]).chips[0];
    expect(c.side).toBe('right');
    const middle = c.box.top + c.box.height / 2;
    expect(middle).toBeLessThan(350);
    // On the line from (500, 350) to (1500, 100): at the chip's near edge x, y = 350 - 250 * (x - 500) / 1000.
    const x = right(c.box) - c.box.width / 2;
    expect(middle).toBeCloseTo(350 - 0.25 * (x - 500), 3);
  });

  it('a corner: the chip is in the corner, inset on both axes, and nothing leaves the pane', () => {
    const c = plan([cur({ x: -3000, y: -3000 })]).chips[0];
    expect(c.box.left).toBeGreaterThanOrEqual(insetPx);
    expect(c.box.top).toBeGreaterThanOrEqual(insetPx);
    const corner = plan([cur({ x: 4000, y: 3000 })]).chips[0];
    expect(right(corner.box)).toBeLessThanOrEqual(VIEW.width - insetPx);
    expect(bottom(corner.box)).toBeLessThanOrEqual(VIEW.height - insetPx);
  });

  it('a cursor in view, and under nothing, has no chip', () => {
    expect(plan([cur({ x: 500, y: 350 }), cur({ x: 1, y: 1 })]).chips).toHaveLength(0);
  });

  it('the chevron turns toward the tip as the tip moves', () => {
    const a = plan([cur({ x: -500, y: 100 })]).chips[0].angle;
    const b = plan([cur({ x: -500, y: 900 })]).chips[0].angle;
    expect(b).toBeGreaterThan(a);
  });
});

describe('docks: a cursor under an open dock is outside the visible pane', () => {
  it('the pane less a left drawer and a right one', () => {
    const pane: Box = { left: 0, top: 0, width: 1200, height: 800 };
    const view = visiblePane(pane, [{ left: 0, top: 0, width: 320, height: 800 }, { left: 900, top: 0, width: 300, height: 800 }]);
    expect(view).toEqual({ left: 320, top: 0, width: 580, height: 800 });
  });

  it('a cursor under the left dock gets a chip just outside the dock\'s edge, 12 px in from it', () => {
    const view = visiblePane({ left: 0, top: 0, width: 1000, height: 700 }, [{ left: 0, top: 0, width: 300, height: 700 }]);
    const c = plan([cur({ x: 100, y: 350 })], [], view).chips[0];
    expect(c.side).toBe('left');
    expect(c.box.left).toBe(300 + insetPx);
  });

  it('a drawer that doesn\'t touch the pane takes nothing from it', () => {
    expect(visiblePane({ left: 0, top: 0, width: 1000, height: 700 }, [{ left: 1100, top: 0, width: 200, height: 700 }]).width).toBe(1000);
  });
});

describe('floating chrome (the Inspector, the Agent log, Updates)', () => {
  const inspector: Obstacle = { id: 'inspector0', box: { left: 700, top: 100, width: 260, height: 400 } };

  it('a cursor under it is off screen: its chip sits just outside the panel\'s edge that faces the pane\'s middle, 12 px clear', () => {
    const c = plan([cur({ x: 830, y: 300 })], [inspector]).chips[0];
    expect(c.side).toBe('left'); // the panel's left edge faces the middle (500, 350)
    expect(right(c.box)).toBe(inspector.box.left - insetPx);
    expect(overlap(c.box, inspector.box)).toBe(false);
  });

  it('a panel low on the screen, a cursor under its upper part: the chip goes above or beside it, never over it', () => {
    const log: Obstacle = { id: 'agent-log0', box: { left: 300, top: 520, width: 400, height: 160 } };
    const c = plan([cur({ x: 500, y: 600 })], [log]).chips[0];
    expect(overlap(c.box, log.box)).toBe(false);
    expect(c.side).toBe('top');
  });

  it('has the same look and the same name as an edge chip', () => {
    const c = plan([cur({ x: 830, y: 300 }, { label: 'Claude · 2' })], [inspector]).chips[0];
    expect(c.label).toBe('Claude · 2');
    expect(chipName(c.label)).toBe('Claude · 2, show where it’s working');
  });

  it('a cursor in view and not under it has no chip', () => {
    expect(plan([cur({ x: 200, y: 300 })], [inspector]).chips).toHaveLength(0);
  });
});

describe('stacking along an edge', () => {
  it('chips on one edge sit 6 px apart or more, in order along it', () => {
    const { chips } = plan([cur({ x: -2000, y: 340 }), cur({ x: -2000, y: 350 }), cur({ x: -2000, y: 360 })]);
    expect(chips).toHaveLength(3);
    const sorted = [...chips].sort((a, b) => a.box.top - b.box.top);
    for (let i = 1; i < sorted.length; i += 1) {
      expect(sorted[i].box.top - bottom(sorted[i - 1].box)).toBeGreaterThanOrEqual(gapPx);
    }
  });

  it('keeps at most 3 per edge, the most recently active, and counts the rest', () => {
    const all = [1, 2, 3, 4, 5].map((i) => cur({ x: -2000, y: 300 + i * 10 }, { key: `k${i}`, activeAt: i * 10 }));
    const { chips, counts } = plan(all);
    expect(chips.map((c) => c.key).sort()).toEqual(['k3', 'k4', 'k5']);
    expect(counts).toHaveLength(1);
    expect(counts[0].count).toBe(2);
    expect(countName(2)).toBe('+2 agents off screen');
    expect(countName(1)).toBe('+1 agent off screen');
  });

  it('exactly 3 have no count', () => {
    const { counts } = plan([1, 2, 3].map((i) => cur({ x: -2000, y: 300 + i * 10 })));
    expect(counts).toHaveLength(0);
  });

  it('the count sits with the stack on the same edge and overlaps nothing', () => {
    const all = [1, 2, 3, 4].map((i) => cur({ x: -2000, y: 300 + i * 10 }, { activeAt: i }));
    const { chips, counts } = plan(all);
    expect(counts[0].side).toBe('left');
    for (const chip of chips) expect(overlap(chip.box, counts[0].box)).toBe(false);
  });

  it('a different edge is its own stack and its own cap', () => {
    const left = [1, 2, 3].map((i) => cur({ x: -2000, y: 300 + i * 10 }));
    const top = [1, 2, 3].map((i) => cur({ x: 400 + i * 20, y: -2000 }));
    const { chips, counts } = plan([...left, ...top]);
    expect(chips).toHaveLength(6);
    expect(counts).toHaveLength(0);
  });
});

describe('no two boxes ever overlap (property test)', () => {
  // A small deterministic generator: the property must hold across many layouts.
  let seed = 12345;
  const rand = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  const between = (lo: number, hi: number) => lo + rand() * (hi - lo);

  it('chips and counts clear each other and the panels they stand off, in 400 random layouts', () => {
    for (let round = 0; round < 400; round += 1) {
      const view: Box = { left: between(0, 300), top: between(0, 80), width: between(500, 1400), height: between(360, 900) };
      const obstacles: Obstacle[] = Array.from({ length: Math.floor(rand() * 4) }, (_, i) => ({
        id: `o${i}`,
        box: { left: between(view.left, view.left + view.width - 120), top: between(view.top, view.top + view.height - 120),
          width: between(80, 420), height: between(80, 420) },
      }));
      const cursors = Array.from({ length: 1 + Math.floor(rand() * 14) }, () => cur(
        { x: between(view.left - 3000, view.left + view.width + 3000), y: between(view.top - 3000, view.top + view.height + 3000) },
        { activeAt: Math.floor(rand() * 100) }));
      const result = planChips({ view, obstacles, cursors, sizes: {
        chip: (c) => ({ width: 60 + (c.key.length % 5) * 20, height: 28 }), count: { width: 36, height: 20 } } });
      const boxes = [...result.chips.map((c) => c.box), ...result.counts.map((c) => c.box)];
      for (let i = 0; i < boxes.length; i += 1) {
        for (let j = i + 1; j < boxes.length; j += 1) expect(overlap(boxes[i], boxes[j])).toBe(false);
      }
      for (const chip of result.chips) {
        // 12 px in from the pane's edges (a chip off a panel keeps inside the pane too).
        expect(chip.box.left).toBeGreaterThanOrEqual(view.left + insetPx - 1e-6);
        expect(chip.box.top).toBeGreaterThanOrEqual(view.top + insetPx - 1e-6);
        expect(right(chip.box)).toBeLessThanOrEqual(view.left + view.width - insetPx + 1e-6);
        expect(bottom(chip.box)).toBeLessThanOrEqual(view.top + view.height - insetPx + 1e-6);
      }
      // At most 3 chips on one edge of one group.
      const per = new Map<string, number>();
      for (const chip of result.chips) per.set(chip.side, (per.get(chip.side) ?? 0) + 1);
      // (groups by panel can add more per side; the cap is per group: the count carries the rest)
      expect(result.chips.length + result.counts.reduce((s, c) => s + c.count, 0)).toBeLessThanOrEqual(cursors.length);
    }
  });
});

describe('the chip width reckoned from the name', () => {
  // The name's width in Chrome at 500 12px system-ui (live shot, 2026-11-05); the rest of the chip is its border,
  // padding, dot, two gaps and the chevron: 46 px. The CSS ellipsis cuts a name by a fraction of a pixel, so
  // "Claude" at 40.3 px in a 40 px slot read "Clau…" when the estimate gave 7 px a letter and no border.
  const NAMES: Array<[string, number]> = [['Claude', 40.34], ['Codex', 36.66], ['Gemini', 40.1], ['Claude · 2', 58.07], ['Hermes', 41]];
  it.each(NAMES)('%s has room for its whole name', (name, textPx) => {
    expect(estimateChipWidth(name) - 46).toBeGreaterThanOrEqual(textPx);
  });
  it('stays at the cap for a long name', () => {
    expect(estimateChipWidth('x'.repeat(60))).toBe(AGENT_CURSOR_CHIP.maxWidthPx);
  });
});
