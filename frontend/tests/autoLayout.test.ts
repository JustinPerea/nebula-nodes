import { describe, it, expect } from 'vitest';
import { computeLayout } from '../src/lib/autoLayout';

const opts = { gapX: 120, gapY: 40, x0: 0, y0: 0 };

describe('computeLayout', () => {
  it('lays a chain out in increasing columns, same row', () => {
    const pos = computeLayout(
      [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      [{ source: 'a', target: 'b' }, { source: 'b', target: 'c' }],
      opts,
    );
    expect(pos.a).toEqual({ x: 0, y: 0 });
    expect(pos.b).toEqual({ x: 360, y: 0 });
    expect(pos.c).toEqual({ x: 720, y: 0 });
  });

  it('stacks siblings of a fan in the same column, different rows', () => {
    const pos = computeLayout(
      [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      [{ source: 'a', target: 'b' }, { source: 'a', target: 'c' }],
      opts,
    );
    expect(pos.a.x).toBe(0);
    expect(pos.b.x).toBe(360);
    expect(pos.c.x).toBe(360);
    expect(pos.b.y).not.toBe(pos.c.y);
  });

  it('uses the LONGEST path (diamond) for the join node column', () => {
    // a->b->d and a->c->d ; also a->d direct. d must be at the deepest layer.
    const pos = computeLayout(
      [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }],
      [
        { source: 'a', target: 'b' },
        { source: 'a', target: 'c' },
        { source: 'b', target: 'd' },
        { source: 'c', target: 'd' },
        { source: 'a', target: 'd' },
      ],
      opts,
    );
    expect(pos.a.x).toBe(0);
    expect(pos.b.x).toBe(360);
    expect(pos.d.x).toBe(720); // longest path a->b->d, not the direct a->d
  });

  it('places disconnected nodes in column 0, stacked', () => {
    const pos = computeLayout([{ id: 'x' }, { id: 'y' }], [], opts);
    expect(pos.x).toEqual({ x: 0, y: 0 });
    expect(pos.y).toEqual({ x: 0, y: 220 });
  });

  it('does not hang on a cycle and returns positions for all nodes', () => {
    const pos = computeLayout(
      [{ id: 'a' }, { id: 'b' }],
      [{ source: 'a', target: 'b' }, { source: 'b', target: 'a' }],
      opts,
    );
    expect(Object.keys(pos).sort()).toEqual(['a', 'b']);
  });

  it('ignores self-loops and edges to missing nodes', () => {
    const pos = computeLayout(
      [{ id: 'a' }],
      [{ source: 'a', target: 'a' }, { source: 'a', target: 'ghost' }],
      opts,
    );
    expect(pos.a).toEqual({ x: 0, y: 0 });
  });

  it('stacks a column by each node\'s measured height', () => {
    // Image cards size to their image: 236, 497 and 300 px tall in the GM session.
    const pos = computeLayout(
      [{ id: 'a', width: 280, height: 236 }, { id: 'b', width: 280, height: 497 }, { id: 'c', width: 280, height: 300 }],
      [],
      opts,
    );
    expect([pos.a.y, pos.b.y, pos.c.y]).toEqual([0, 276, 813]);
  });

  it('starts the next column after the widest node in the previous one', () => {
    const pos = computeLayout(
      [{ id: 'wide', width: 520, height: 300 }, { id: 'narrow', width: 200, height: 100 }, { id: 'next' }],
      [{ source: 'wide', target: 'next' }, { source: 'narrow', target: 'next' }],
      opts,
    );
    expect(pos.next).toEqual({ x: 640, y: 0 });
  });

  it('keeps the old fixed steps for nodes the canvas has not measured', () => {
    const pos = computeLayout([{ id: 'a' }, { id: 'b', width: 0, height: Number.NaN }], [], {});
    expect(pos.b).toEqual({ x: 0, y: 220 });
  });

  it('never overlaps measured boxes in a column', () => {
    const heights = [236, 497, 300, 120, 410];
    const nodes = heights.map((height, i) => ({ id: `n${i}`, width: 300, height }));
    const pos = computeLayout(nodes, [], opts);
    for (let i = 1; i < nodes.length; i++) {
      expect(pos[`n${i}`].y).toBeGreaterThanOrEqual(pos[`n${i - 1}`].y + heights[i - 1] + 40);
    }
  });
});
