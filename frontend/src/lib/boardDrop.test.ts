import { describe, expect, it } from 'vitest';
import { DROP_GAP, dropLayout, provisionalForCreate } from './boardDrop';

// Files dropped on the Board view: one card centred at the pointer, more in a
// row centred there, each its own size (from its aspect), a gap between.

describe('dropLayout', () => {
  it('centres one card on the point', () => {
    expect(dropLayout({ x: 500, y: 300 }, [[480, 270]])).toEqual([{ x: 260, y: 165 }]);
  });

  it('puts more in a row centred on the point, middles on one line', () => {
    const spots = dropLayout({ x: 0, y: 0 }, [[480, 270], [312, 416]]);
    const total = 480 + DROP_GAP + 312;
    expect(spots).toEqual([{ x: Math.round(-total / 2), y: -135 }, { x: Math.round(-total / 2 + 480 + DROP_GAP), y: -208 }]);
  });

  it('is nothing for no files', () => {
    expect(dropLayout({ x: 1, y: 1 }, [])).toEqual([]);
  });
});

describe('provisionalForCreate', () => {
  it("sends a dropped card's place without the id the Studio made up for it", () => {
    const images = [
      { id: 'a', url: '/a.png', weight: 1, notes: '', excluded: false,
        placements: [{ id: 'new-a', frameId: null, x: 10, y: 20, w: 480, h: 270, weight: 1, placedBy: 'person' as const, placedAt: '' }] },
      { id: 'b', url: '/b.png', weight: 1, notes: '', excluded: false },
    ];
    expect(provisionalForCreate(images)).toEqual([
      { id: 'a', url: '/a.png', weight: 1, notes: '', excluded: false, placements: [{ frameId: null, x: 10, y: 20 }] },
      { id: 'b', url: '/b.png', weight: 1, notes: '', excluded: false },
    ]);
  });
});
