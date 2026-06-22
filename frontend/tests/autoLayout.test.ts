import { describe, it, expect } from 'vitest';
import { computeLayout } from '../src/lib/autoLayout';

const opts = { colGap: 360, rowGap: 220, x0: 0, y0: 0 };

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
});
