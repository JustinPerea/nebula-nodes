import { describe, expect, it } from 'vitest';
import type { MoodboardImage, MoodboardPlacement } from '../types';
import { applyOps, opSteers, queueOps, rebaseDraft, type MoodboardOp } from './moodboardEdits';
import { FULL_AREA, sizeFor } from './moodboardLayout';

// The Board view's ops (moodboard canvas PR5): a card moved on the canvas is
// one `place` op, and an image dropped at the pointer is an `add` with `at`.

const card = (id: string, extra: Partial<MoodboardPlacement> = {}): MoodboardPlacement => ({
  id, frameId: null, x: 0, y: 0, w: 480, h: 270, weight: 1, placedBy: 'person', placedAt: '2026-10-20T00:00:00+00:00', ...extra });
const image = (id: string, extra: Partial<MoodboardImage> = {}): MoodboardImage => (
  { id, url: `/api/outputs/${id}.png`, weight: 1, notes: '', privateNote: '', excluded: false, placements: [card(`c-${id}`)], ...extra });

describe('the place op', () => {
  it('moves one card and leaves the image order alone', () => {
    const images = [image('i1'), image('i2'), image('i3')];
    const next = applyOps(images, [{ op: 'place', placement: 'c-i2', x: 640, y: -40 }]);
    expect(next.map((img) => img.id)).toEqual(['i1', 'i2', 'i3']);
    expect(next[1].placements?.[0]).toMatchObject({ id: 'c-i2', x: 640, y: -40, w: 480, h: 270 });
    expect(next[0]).toBe(images[0]);
    expect(next[2]).toBe(images[2]);
  });

  it('a card that is gone changes nothing', () => {
    const images = [image('i1')];
    expect(applyOps(images, [{ op: 'place', placement: 'nope', x: 1, y: 1 }])).toEqual(images);
  });

  it('never steers: moving a card keeps the analysis', () => {
    expect(opSteers({ op: 'place', placement: 'c-i1', x: 1, y: 2 })).toBe(false);
    expect(opSteers({ op: 'remove', images: ['i1'] })).toBe(true);
  });

  it('queues one op per card, the latest last', () => {
    let queue = queueOps([], [{ op: 'place', placement: 'a', x: 1, y: 1 }]);
    queue = queueOps(queue, [{ op: 'note', image: 'i1', notes: 'x' }]);
    queue = queueOps(queue, [{ op: 'place', placement: 'a', x: 9, y: 9 }, { op: 'place', placement: 'b', x: 2, y: 2 }]);
    expect(queue).toEqual([
      { op: 'note', image: 'i1', notes: 'x' },
      { op: 'place', placement: 'a', x: 9, y: 9 },
      { op: 'place', placement: 'b', x: 2, y: 2 },
    ]);
  });

  it('a rebase drops a queued move of a card someone else removed, and replays the rest', () => {
    const queued: MoodboardOp[] = [
      { op: 'place', placement: 'c-i1', x: 100, y: 100 },
      { op: 'place', placement: 'c-i2', x: 300, y: 300 },
    ];
    const draft = { images: [image('i1'), image('i2')], pendingOps: queued, version: 1 };
    const rebased = rebaseDraft(draft, { images: [image('i1'), image('i3')], version: 2 }, {});
    expect(rebased.pendingOps).toEqual([queued[0]]);
    expect(rebased.images.map((img) => [img.id, img.placements?.[0].x])).toEqual([['i1', 100], ['i3', 0]]);
  });
});

describe('an image dropped at the pointer', () => {
  it('shows a card there at once, sized as the server will size it', () => {
    const next = applyOps([image('i1')], [{ op: 'add', images: [{ id: 'n1', url: '/api/outputs/n1.png' }], at: { x: 50, y: 60 } }],
      { aspects: { '/api/outputs/n1.png': 3 / 4 } });
    const [w, h] = sizeFor(1, 3 / 4);
    expect(next[1].id).toBe('n1');
    expect(next[1].placements).toEqual([expect.objectContaining({ frameId: null, x: 50, y: 60, w, h, weight: 1 })]);
    expect(Math.abs(w * h - FULL_AREA)).toBeLessThan(w + h);
  });

  it('with no aspect known it takes the server default (4:3)', () => {
    const [placement] = applyOps([], [{ op: 'add', images: [{ id: 'n1', url: '/x.png' }], at: { x: 0, y: 0 } }])[0].placements!;
    expect([placement.w, placement.h]).toEqual(sizeFor(1, 4 / 3));
  });

  it('sizeFor matches the backend (moodboard_layout.size_for)', () => {
    expect(sizeFor(1, 16 / 9)).toEqual([480, 270]);
    expect(sizeFor(0.05, 16 / 9)).toEqual([107, 60]);
    expect(sizeFor(2, 1)).toEqual([360, 360]);
    expect(sizeFor(0, Number.NaN)).toEqual(sizeFor(0.05, 4 / 3));
  });
});
