import { describe, expect, it } from 'vitest';
import { boundingRect, findOpenGroupOffset, type NodeRect } from '../../src/lib/nodePlacement';

const moved = (rects: NodeRect[], offset: { x: number; y: number }) =>
  rects.map((rect) => ({ ...rect, x: rect.x + offset.x, y: rect.y + offset.y }));
const overlaps = (a: NodeRect, b: NodeRect) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

describe('findOpenGroupOffset (a paste from another project)', () => {
  const group: NodeRect[] = [{ x: 1000, y: 1000, width: 300, height: 400 }, { x: 1400, y: 1100, width: 200, height: 200 }];

  it('centres the group on the view when the spot is free, keeping its layout', () => {
    const offset = findOpenGroupOffset(group, [{ x: -2000, y: -2000, width: 300, height: 300 }], { x: 0, y: 0 });
    const box = boundingRect(moved(group, offset));
    expect(box.x + box.width / 2).toBe(0);
    expect(box.y + box.height / 2).toBe(0);
    const [a, b] = moved(group, offset);
    expect({ dx: b.x - a.x, dy: b.y - a.y }).toEqual({ dx: 400, dy: 100 });
  });

  it('moves the group clear of nodes in the middle of the view, close by', () => {
    const occupied: NodeRect[] = [
      { x: -250, y: -250, width: 500, height: 500 },
      { x: 400, y: -100, width: 300, height: 300 },
    ];
    const offset = findOpenGroupOffset(group, occupied, { x: 0, y: 0 });
    const placed = moved(group, offset);
    const box = boundingRect(placed);
    for (const rect of occupied) expect(overlaps(box, rect)).toBe(false);
    // Near the view centre, not flung off.
    expect(Math.hypot(box.x + box.width / 2, box.y + box.height / 2)).toBeLessThan(1200);
  });

  it('a group with nothing on the canvas still goes to the view centre', () => {
    const offset = findOpenGroupOffset(group, [], { x: 500, y: -300 });
    const box = boundingRect(moved(group, offset));
    expect([box.x + box.width / 2, box.y + box.height / 2]).toEqual([500, -300]);
  });

  it('prefers a clear spot inside the view to a nearer one outside it', () => {
    const view: NodeRect = { x: 0, y: 0, width: 1000, height: 600 };
    const occupied: NodeRect[] = [{ x: 300, y: 150, width: 400, height: 300 }];
    const box = boundingRect(moved([{ x: 0, y: 0, width: 200, height: 200 }],
      findOpenGroupOffset([{ x: 0, y: 0, width: 200, height: 200 }], occupied, { x: 500, y: 300 }, view)));
    expect(overlaps(box, occupied[0])).toBe(false);
    expect(box.x >= 0 && box.y >= 0 && box.x + box.width <= 1000 && box.y + box.height <= 600).toBe(true);
  });

  it('with no clear spot in the view, the nearest clear one (the canvas then shows it)', () => {
    const view: NodeRect = { x: 0, y: 0, width: 500, height: 500 };
    const occupied: NodeRect[] = [{ x: 0, y: 0, width: 500, height: 500 }];
    const box = boundingRect(moved([{ x: 0, y: 0, width: 300, height: 300 }],
      findOpenGroupOffset([{ x: 0, y: 0, width: 300, height: 300 }], occupied, { x: 250, y: 250 }, view)));
    expect(overlaps(box, occupied[0])).toBe(false);
    expect(Math.hypot(box.x + 150 - 250, box.y + 150 - 250)).toBeLessThan(700);
  });
});

