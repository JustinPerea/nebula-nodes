import { describe, expect, it } from 'vitest';
import { arrangeNewNodes, ARRANGE_STACK_GAP, type ArrangeRequest, type PlacedNode } from '../src/lib/arrangeEdit';

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
