import { describe, expect, it } from 'vitest';
import { mergeRunEstimates, type RunEstimate } from '../src/lib/placeholderRunConfirm';
import type { RunCost } from '../src/lib/runScope';

// Review 16, M2 (round 17): a re-ask after a route change prices the rows
// that kept their route at Nebula's estimate and the moved ones at the
// canvas's numbers for their new route.
const refused: RunEstimate = { low: 0.13, high: 0.13, nodes: { a: { low: 0.07, high: 0.07 }, b: { low: 0.06, high: 0.06 } },
  unpriced: [], plan: [], plus: [], unavailable: {}, awaitingInput: [] };
const canvas = (extra: Partial<RunCost>): RunCost => ({ low: 0, high: 0, lines: [], unpriced: [], plan: [], plus: [], awaitingInput: [],
  sizeRefs: [], ids: { unpriced: [], plan: [], awaitingInput: [] }, ...extra });

describe('mergeRunEstimates', () => {
  it('a moved row with no list price on its new route: unpriced, and only the rest is summed', () => {
    const merged = mergeRunEstimates(refused, canvas({ unpriced: ['A'], ids: { unpriced: ['a'], plan: [], awaitingInput: [] } }), new Set(['a']));
    expect(merged.nodes).toEqual({ b: { low: 0.06, high: 0.06 } });
    expect(merged.unpriced).toEqual(['a']);
    expect([merged.low, merged.high]).toEqual([0.06, 0.06]);
  });

  it('a moved row priced on its new route takes the canvas price; the others keep Nebula\'s', () => {
    const merged = mergeRunEstimates(refused, canvas({ lines: [{ name: 'A', low: 0.03, high: 0.03, runs: [1, 1], nodeId: 'a' },
      { name: 'B', low: 0.99, high: 0.99, runs: [1, 1], nodeId: 'b' }] }), new Set(['a']));
    expect(merged.nodes).toEqual({ a: { low: 0.03, high: 0.03 }, b: { low: 0.06, high: 0.06 } });
    expect(merged.high).toBeCloseTo(0.09);
  });

  it('nothing priced: no total (null), as Nebula sends it', () => {
    const merged = mergeRunEstimates({ ...refused, nodes: { a: { low: 0.07, high: 0.07 } } },
      canvas({ ids: { unpriced: [], plan: ['a'], awaitingInput: [] } }), new Set(['a']));
    expect(merged.plan).toEqual(['a']);
    expect([merged.low, merged.high]).toEqual([null, null]);
  });

  it('a moved row whose new route can\'t run keeps its reason', () => {
    const merged = mergeRunEstimates(refused, canvas({ ids: { unpriced: ['a'], plan: [], awaitingInput: [], unavailable: { a: 'Add an xAI key.' } } }), new Set(['a']));
    expect(merged.unavailable).toEqual({ a: 'Add an xAI key.' });
  });

  it('nothing moved: Nebula\'s estimate as it is', () => {
    expect(mergeRunEstimates(refused, canvas({}), new Set())).toEqual(refused);
  });
});
