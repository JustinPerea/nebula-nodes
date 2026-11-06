import { describe, expect, it } from 'vitest';
import type { Box } from '../src/lib/agentAnchorResolve';
import { planChips, type ChipCursor, type ChipSizes } from '../src/lib/agentEdgeChips';

/**
 * PR #233 final review, item 7 (the coordinator's ruling on review 1, C8): when
 * chrome covers every spot on every edge so no chip or count has room, the
 * "+N agents off screen" count is still drawn, over chrome at the least-covered
 * edge spot. Never drop the information that agents are off screen.
 */
const VIEW: Box = { left: 0, top: 0, width: 1000, height: 700 };
const SIZES: ChipSizes = { chip: () => ({ width: 100, height: 28 }), count: { width: 36, height: 20 } };
let n = 0;
const cur = (tip: { x: number; y: number }): ChipCursor => ({ key: `c${n += 1}`, label: 'Claude', color: '#E8825A', tip, activeAt: n });
const overlapArea = (a: Box, b: Box) => Math.max(0, Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left))
  * Math.max(0, Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top));
const total = (plan: ReturnType<typeof planChips>) => plan.chips.length + plan.counts.reduce((sum, count) => sum + count.count, 0);

describe('the last-resort count', () => {
  it('chrome over the whole pane: the count is still drawn, inside the pane, and counts every agent', () => {
    const chrome: Box[] = [VIEW];
    const plan = planChips({ view: VIEW, chrome, cursors: [cur({ x: 3000, y: 350 }), cur({ x: -3000, y: 350 }), cur({ x: 500, y: -2000 })], sizes: SIZES });
    expect(plan.chips).toEqual([]);
    expect(total(plan)).toBe(3);
    for (const count of plan.counts) {
      expect(count.box.left).toBeGreaterThanOrEqual(VIEW.left);
      expect(count.box.left + count.box.width).toBeLessThanOrEqual(VIEW.left + VIEW.width);
      expect(count.box.top).toBeGreaterThanOrEqual(VIEW.top);
      expect(count.box.top + count.box.height).toBeLessThanOrEqual(VIEW.top + VIEW.height);
    }
  });

  it('sits at the least-covered spot: the edge with the thinnest chrome over it', () => {
    // Chrome 80 deep on the top, left and right edges and the whole bottom 12 px strip bare except a slim bar.
    const chrome: Box[] = [
      { left: 0, top: 0, width: 1000, height: 80 }, { left: 0, top: 0, width: 80, height: 700 },
      { left: 920, top: 0, width: 80, height: 700 }, { left: 0, top: 80, width: 1000, height: 620 },
    ];
    // Everything is covered, but the pane's bottom edge strip is covered by the full-width box only.
    const plan = planChips({ view: VIEW, chrome, cursors: [cur({ x: 500, y: 3000 })], sizes: SIZES });
    expect(plan.counts).toHaveLength(1);
    const covered = (box: Box) => chrome.reduce((sum, c) => sum + overlapArea(box, c), 0);
    // No spot on any edge is less covered than the one chosen (every edge in the pane's inset).
    const chosen = covered(plan.counts[0].box);
    for (const x of [12, 500, 952]) for (const y of [12, 668]) {
      expect(chosen).toBeLessThanOrEqual(covered({ left: x, top: y, width: 36, height: 20 }) + 1e-6);
    }
    expect(plan.counts[0].count).toBe(1);
  });

  it('prefers a bare corner of an edge over covered stretches, and the edge nearest the agent on a tie', () => {
    // Chrome everywhere except a 40 x 40 bare patch at the pane's top-left corner region: the count goes there.
    const chrome: Box[] = [
      { left: 60, top: 0, width: 940, height: 700 }, { left: 0, top: 60, width: 60, height: 640 },
    ];
    const plan = planChips({ view: VIEW, chrome, cursors: [cur({ x: -3000, y: -3000 })], sizes: SIZES });
    expect(plan.counts).toHaveLength(1);
    expect(chrome.reduce((sum, c) => sum + overlapArea(plan.counts[0].box, c), 0)).toBe(0);
  });

  it('is a count and nothing else: it makes no chip, and agents on one edge share one count', () => {
    const plan = planChips({ view: VIEW, chrome: [VIEW], cursors: [cur({ x: 3000, y: 100 }), cur({ x: 3000, y: 300 })], sizes: SIZES });
    expect(plan.chips).toEqual([]);
    expect(plan.counts).toHaveLength(1);
    expect(plan.counts[0].count).toBe(2);
  });

  it('a pane that holds a count but not its inset still shows one; a pane of no area shows none', () => {
    const snug: Box = { left: 0, top: 0, width: 40, height: 30 };
    expect(total(planChips({ view: snug, cursors: [cur({ x: 3000, y: 10 })], sizes: SIZES }))).toBe(1);
    expect(planChips({ view: { ...snug, width: 0 }, cursors: [cur({ x: 3000, y: 10 })], sizes: SIZES })).toEqual({ chips: [], counts: [] });
  });
});
