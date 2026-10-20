import { describe, expect, it } from 'vitest';
import type { MoodboardImage } from '../types';
import { applyOps, queueOps, rebaseDraft, type MoodboardOp } from './moodboardEdits';
import { boardCover, coverUrl } from './moodboardCover';

// A board's cover: the image it opens on (Justin, 2026-10-20). A pick, not a
// reorder: the Studio queues a `cover` op like its other image edits, and
// nothing about the images changes.

const image = (id: string, extra: Partial<MoodboardImage> = {}): MoodboardImage => (
  { id, url: `/api/outputs/${id}.png`, weight: 1, notes: '', privateNote: '', excluded: false, ...extra });

describe('the cover', () => {
  it('is the chosen image when it is on the board, else #1, else none', () => {
    const images = [image('i1'), image('i2'), image('i3', { excluded: true })];
    expect(boardCover(images, 'i3')).toEqual({ id: 'i3', number: 3, chosen: true });
    expect(boardCover(images, null)).toEqual({ id: 'i1', number: 1, chosen: false });
    expect(boardCover(images, undefined)).toEqual({ id: 'i1', number: 1, chosen: false });
    // A cover whose image left the board opens it on #1 again.
    expect(boardCover(images, 'gone')).toEqual({ id: 'i1', number: 1, chosen: false });
    expect(boardCover([], 'i1')).toBeNull();
    expect(coverUrl(images, 'i2')).toBe('/api/outputs/i2.png');
    expect(coverUrl(images, null)).toBe('/api/outputs/i1.png');
    expect(coverUrl([], null)).toBe('');
  });

  it('is one queued op, the latest; it moves no image', () => {
    const images = [image('i1'), image('i2')];
    let queue = queueOps([], [{ op: 'cover', image: 'i2' }]);
    queue = queueOps(queue, [{ op: 'weight', image: 'i1', value: 0.5 }, { op: 'cover', image: null }]);
    expect(queue).toEqual([{ op: 'weight', image: 'i1', value: 0.5 }, { op: 'cover', image: null }]);
    expect(applyOps(images, [{ op: 'cover', image: 'i2' }])).toEqual(images);
  });

  it("rebases on the board's cover and replays a queued pick on top", () => {
    const draft = { images: [image('i1'), image('i2')], coverImageId: 'i2' as string | null,
      pendingOps: [{ op: 'cover', image: 'i2' }] as MoodboardOp[], version: 1 };
    const board = { images: [image('i1'), image('i2'), image('i3')], coverImageId: 'i3', version: 2 };
    expect(rebaseDraft(draft, board, {}).coverImageId).toBe('i2');
    // Confirmed: the board's cover stands.
    expect(rebaseDraft(draft, board, {}, new Set(draft.pendingOps)).coverImageId).toBe('i3');
    // Back to #1 is kept even though it names no image.
    const cleared = rebaseDraft({ ...draft, pendingOps: [{ op: 'cover', image: null }] }, board, {});
    expect(cleared.pendingOps).toEqual([{ op: 'cover', image: null }]);
    expect(cleared.coverImageId).toBeNull();
  });

  it('drops a queued pick of an image someone removed, and takes the board cover', () => {
    const draft = { images: [image('i1'), image('i2')], coverImageId: 'i2' as string | null,
      pendingOps: [{ op: 'cover', image: 'i2' }] as MoodboardOp[], version: 1 };
    const rebased = rebaseDraft(draft, { images: [image('i1')], coverImageId: null, version: 2 }, {});
    expect(rebased.pendingOps).toEqual([]);
    expect(rebased.coverImageId).toBeNull();
  });

  it('falls back to #1 when a queued remove takes the cover image', () => {
    const draft = { images: [image('i1')], coverImageId: null as string | null,
      pendingOps: [{ op: 'remove', images: ['i2'] }] as MoodboardOp[], version: 1 };
    const rebased = rebaseDraft(draft, { images: [image('i1'), image('i2')], coverImageId: 'i2', version: 2 }, {});
    expect(rebased.images.map((img) => img.id)).toEqual(['i1']);
    expect(rebased.coverImageId).toBeNull();
  });
});
