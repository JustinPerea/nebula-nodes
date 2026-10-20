import { describe, expect, it } from 'vitest';
import { arrangeNewNodes, ARRANGE_STACK_GAP, inside, type ArrangeRequest, type Box, type PlacedNode } from '../src/lib/arrangeEdit';

const request = (nodeIds: string[], extra: Partial<ArrangeRequest> = {}): ArrangeRequest => ({
  id: 'a_1', nodeIds, direction: 'right', gap: 120, ...extra,
});
const placed = (id: string, x: number, y: number, width: number, height: number): PlacedNode => ({
  id, position: { x, y }, width, height,
});

function boxes(nodes: PlacedNode[], positions: Record<string, { x: number; y: number }>) {
  return nodes.map((node) => {
    const point = positions[node.id] ?? node.position;
    return { id: node.id, left: point.x, top: point.y, right: point.x + node.width!, bottom: point.y + node.height! };
  });
}
function overlapping(nodes: PlacedNode[], positions: Record<string, { x: number; y: number }>): string[] {
  const all = boxes(nodes, positions);
  const hits: string[] = [];
  for (let i = 0; i < all.length; i += 1) {
    for (let j = i + 1; j < all.length; j += 1) {
      const a = all[i];
      const b = all[j];
      if (a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom) hits.push(`${a.id}/${b.id}`);
    }
  }
  return hits;
}

describe('arrangeNewNodes', () => {
  it('stacks image cards of different heights without overlap, from where the agent put them', () => {
    // The agent placed 4 image cards 200 px apart; they render 500, 140, 320 and 610 px tall.
    const fresh = [500, 140, 320, 610].map((h, i) => placed(`n${i + 1}`, 1000, 200 * i + 100, 260, h));
    expect(overlapping(fresh, {})).not.toEqual([]);

    const positions = arrangeNewNodes(request(fresh.map((n) => n.id)), fresh, [])!;

    expect(overlapping(fresh, positions)).toEqual([]);
    expect(positions.n1).toEqual({ x: 1000, y: 100 });
    expect(positions.n2.y).toBe(100 + 500 + ARRANGE_STACK_GAP);
  });

  it('never positions nodes outside the request, and steps clear of them', () => {
    const mine = [placed('n5', 0, 0, 240, 300), placed('n6', 0, 50, 240, 300)];
    const theirs = [placed('n1', 0, 400, 240, 180), placed('n2', 300, 0, 240, 900)];
    const all = [...theirs, ...mine];

    const positions = arrangeNewNodes(request(['n5', 'n6']), all, [])!;

    expect(Object.keys(positions).sort()).toEqual(['n5', 'n6']);
    expect(overlapping(all, positions)).toEqual([]);
  });

  it('follows the wiring between the new nodes, right or down', () => {
    const nodes = [placed('n1', 100, 100, 240, 180), placed('n2', 100, 100, 300, 400), placed('n3', 100, 100, 240, 180)];
    const edges = [{ source: 'n1', target: 'n2' }, { source: 'n2', target: 'n3' }];

    const right = arrangeNewNodes(request(['n1', 'n2', 'n3'], { gap: 60 }), nodes, edges)!;
    expect(right).toEqual({ n1: { x: 100, y: 100 }, n2: { x: 400, y: 100 }, n3: { x: 760, y: 100 } });

    const down = arrangeNewNodes(request(['n1', 'n2', 'n3'], { direction: 'down', gap: 60 }), nodes, edges)!;
    expect(down).toEqual({ n1: { x: 100, y: 100 }, n2: { x: 100, y: 340 }, n3: { x: 100, y: 800 } });
  });

  it('skips nodes that are gone and returns null when none are left', () => {
    const nodes = [placed('n1', 0, 0, 240, 180)];
    expect(Object.keys(arrangeNewNodes(request(['n1', 'n9']), nodes, [])!)).toEqual(['n1']);
    expect(arrangeNewNodes(request(['n9']), nodes, [])).toBeNull();
  });
});

describe('arrangeNewNodes inside the visible area', () => {
  // What the person sees, in flow units, below the top bar and above the toolbar.
  const view: Box = { left: 0, top: 100, right: 1200, bottom: 800 };
  const block = (positions: Record<string, { x: number; y: number }>, nodes: PlacedNode[]): Box => ({
    left: Math.min(...nodes.map((n) => positions[n.id].x)),
    top: Math.min(...nodes.map((n) => positions[n.id].y)),
    right: Math.max(...nodes.map((n) => positions[n.id].x + n.width!)),
    bottom: Math.max(...nodes.map((n) => positions[n.id].y + n.height!)),
  });

  it('moves a block placed under the top bar down into view', () => {
    // The agent's edit landed at y=20; the top bar covers everything above y=100.
    const fresh = [placed('n1', 300, 20, 240, 180), placed('n2', 300, 20, 240, 180)];
    const edges = [{ source: 'n1', target: 'n2' }];

    const positions = arrangeNewNodes(request(['n1', 'n2'], { gap: 60 }), fresh, edges, view)!;

    expect(inside(block(positions, fresh), view)).toBe(true);
    expect(positions.n1).toEqual({ x: 300, y: 100 });
  });

  it('finds free room inside the view when stepping past a node would leave it', () => {
    // Below the node it hits is the shorter way, but that is off screen.
    const short: Box = { left: 0, top: 100, right: 1200, bottom: 600 };
    const theirs = [placed('n1', 0, 100, 800, 300)];
    const fresh = [placed('n2', 100, 120, 240, 180)];

    const positions = arrangeNewNodes(request(['n2']), [...theirs, ...fresh], [], short)!;

    expect(inside(block(positions, fresh), short)).toBe(true);
    expect(positions.n2.x).toBeGreaterThanOrEqual(840);
    expect(overlapping([...theirs, ...fresh], positions)).toEqual([]);
  });

  it('keeps a block too big for the view where it was placed (the canvas pans to it instead)', () => {
    const fresh = [placed('n1', 300, 20, 1400, 900)];
    expect(arrangeNewNodes(request(['n1']), fresh, [], view)).toEqual({ n1: { x: 300, y: 20 } });
  });
});
