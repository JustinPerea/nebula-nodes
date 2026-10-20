import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Moodboard, MoodboardImage } from '../types';

const backend = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('./backend', () => ({ apiFetch: backend.apiFetch, rewriteBackendAssetUrls: (value: unknown) => value }));
vi.mock('./currentProject', () => ({ resolveProjectId: async () => 'p1' }));

import { editMoodboard, updateMoodboard } from './api';
import { MoodboardVersionConflict, applyOps, fieldChanges, imagePatchOps, mergeFields, queueOps, rebaseDraft, sendableBatch,
  type MoodboardOp } from './moodboardEdits';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const image = (id: string, extra: Partial<MoodboardImage> = {}): MoodboardImage => (
  { id, url: `/api/outputs/${id}.png`, weight: 1, notes: '', privateNote: '', excluded: false, ...extra });

beforeEach(() => backend.apiFetch.mockReset());

describe('the Studio edit queue', () => {
  it('keeps one op per thing set, latest last; adds and removes all stay', () => {
    let queue = queueOps([], [{ op: 'weight', image: 'i1', value: 0.2 }]);
    queue = queueOps(queue, [{ op: 'note', image: 'i1', notes: 't' }, { op: 'note', image: 'i1', privateNote: 'p' }]);
    queue = queueOps(queue, [{ op: 'remove', images: ['i2'] }, { op: 'weight', image: 'i1', value: 0.6 }]);
    queue = queueOps(queue, [{ op: 'note', image: 'i1', notes: 'teal' }, { op: 'remove', images: ['i3'] }]);
    expect(queue).toEqual([
      { op: 'note', image: 'i1', privateNote: 'p' },
      { op: 'remove', images: ['i2'] },
      { op: 'weight', image: 'i1', value: 0.6 },
      { op: 'note', image: 'i1', notes: 'teal' },
      { op: 'remove', images: ['i3'] },
    ]);
  });

  it('turns a Studio change into ops; using a weight-0 image again leaves its weight to the server', () => {
    expect(imagePatchOps('i1', { weight: 0.5 })).toEqual([{ op: 'weight', image: 'i1', value: 0.5 }]);
    expect(imagePatchOps('i1', { excluded: false, weight: 0.55 })).toEqual([{ op: 'setAside', image: 'i1', value: false }]);
    expect(imagePatchOps('i1', { notes: 'a', privateNote: 'b' })).toEqual([
      { op: 'note', image: 'i1', notes: 'a' }, { op: 'note', image: 'i1', privateNote: 'b' }]);
  });

  it('applies ops as the server does, and an op on an image that is gone changes nothing', () => {
    const images = [image('i1'), image('i2', { weight: 0, placements: [{ id: 'c', frameId: null, x: 0, y: 0, w: 1, h: 1,
      weight: 0.4, placedBy: 'person', placedAt: '' }] })];
    const next = applyOps(images, [
      { op: 'add', images: [{ id: 'n1', url: '/a.png' }], index: 1 },
      { op: 'setAside', image: 'i2', value: false },
      { op: 'weight', image: 'gone', value: 0.1 },
      { op: 'remove', images: ['i1'] },
      { op: 'add', images: [{ url: '/api/outputs/i2.png' }], unique: true },
    ]);
    expect(next.map((img) => [img.id, img.weight])).toEqual([['n1', 1], ['i2', 0.4]]);
  });
});

describe('rebasing a draft', () => {
  const base: Record<string, unknown> = { name: 'Board', notes: '', strength: 0.7, analysis: { summary: 'Warm.' } };

  it('sends only the board fields that changed, and the analysis only as cleared', () => {
    expect(fieldChanges(base, { ...base, name: 'New' })).toEqual({ name: 'New' });
    expect(fieldChanges(base, { ...base, analysis: null, strength: 0.2 })).toEqual({ strength: 0.2, analysis: null });
    expect(fieldChanges(base, { ...base, analysis: { summary: 'Other' } })).toEqual({});
  });

  it("keeps the person's changed fields, takes the rest from the board, and replays the queue", () => {
    expect(mergeFields({ ...base, name: 'Mine' }, base, { ...base, name: 'Theirs', strength: 0.2 }))
      .toEqual({ ...base, name: 'Mine', strength: 0.2 });
    const sent: MoodboardOp = { op: 'weight', image: 'i1', value: 0.5 };
    const draft = { ...base, name: 'Mine', images: [image('i1', { weight: 0.5, notes: 'x' })], base, version: 1,
      pendingOps: [sent, { op: 'note', image: 'i1', notes: 'x' } as MoodboardOp] };
    const board = { images: [image('i1', { weight: 0.5 }), image('cli')], version: 3 };
    const next: Record<string, unknown> & typeof draft = rebaseDraft(draft as Record<string, unknown> & typeof draft, board,
      { ...base, strength: 0.2, analysis: { summary: 'New' } }, new Set([sent]));
    expect(next.pendingOps).toEqual([{ op: 'note', image: 'i1', notes: 'x' }]);
    expect(next.images.map((img) => [img.id, img.weight, img.notes])).toEqual([['i1', 0.5, 'x'], ['cli', 1, '']]);
    expect([next.name, next.strength, next.version, next.analysis]).toEqual(['Mine', 0.2, 3, null]);
  });

  it('drops queued ops on an image that is gone, after replaying the queued adds and removes', () => {
    const add: MoodboardOp = { op: 'add', images: [{ id: 'new', url: '/new.png' }] };
    const pendingOps: MoodboardOp[] = [{ op: 'weight', image: 'i2', value: 0.5 }, add,
      { op: 'note', image: 'new', notes: 'mine' }, { op: 'remove', images: ['i1'] },
      { op: 'setAside', image: 'i1', value: true }, { op: 'weight', image: 'cli', value: 0.3 }];
    const draft = { ...base, images: [image('i1'), image('i2')], base, version: 1, pendingOps };
    // Someone removed i2 and added cli meanwhile.
    const next = rebaseDraft(draft, { images: [image('i1'), image('cli')], version: 2 }, base);
    expect(next.pendingOps).toEqual([add, pendingOps[2], pendingOps[3], pendingOps[5]]);
    expect(next.images.map((img) => [img.id, img.weight, img.notes])).toEqual([['cli', 0.3, ''], ['new', 1, 'mine']]);
  });
});

describe('writes sent with baseVersion', () => {
  const board = { id: 'b1', version: 4, images: [] } as unknown as Moodboard;

  it('a 409 is a MoodboardVersionConflict carrying the board as it is now', async () => {
    backend.apiFetch.mockResolvedValue(json(409, { detail: 'changed', code: 'version_conflict', version: 4, board }));
    const put = updateMoodboard('b1', { name: 'x', baseVersion: 3 }).catch((err: unknown) => err);
    expect(await put).toBeInstanceOf(MoodboardVersionConflict);
    expect((await put as MoodboardVersionConflict).board.version).toBe(4);
    const edit = editMoodboard('b1', [{ op: 'remove', images: ['i1'] }], 3).catch((err: unknown) => err);
    expect(await edit).toBeInstanceOf(MoodboardVersionConflict);
  });

  it('sends the ops with baseVersion, and says why an edit was refused', async () => {
    backend.apiFetch.mockResolvedValueOnce(json(200, { board, version: 4, applied: [], undo: { ops: [] } }));
    await editMoodboard('b1', [{ op: 'weight', image: 'i1', value: 0.5 }], 3);
    const [url, init] = backend.apiFetch.mock.calls[0];
    expect(url).toBe('/api/moodboards/b1/edits');
    expect(JSON.parse(init.body)).toEqual({ ops: [{ op: 'weight', image: 'i1', value: 0.5 }], baseVersion: 3 });
    backend.apiFetch.mockResolvedValueOnce(json(422, { detail: 'op 1 (weight): value must be 0 to 1' }));
    await expect(editMoodboard('b1', [{ op: 'weight', image: 'i1', value: 5 }])).rejects.toThrow(
      'Save failed: op 1 (weight): value must be 0 to 1');
  });
});

describe('a batch as it is sent', () => {
  it('ends with cover null when its last pick names an image it takes off', () => {
    const pick: MoodboardOp = { op: 'cover', image: 'i2' };
    const remove: MoodboardOp = { op: 'remove', images: ['i2'] };
    expect(sendableBatch([pick, remove])).toEqual([pick, remove, { op: 'cover', image: null }]);
  });

  it('is left as it is otherwise', () => {
    const ops: MoodboardOp[] = [{ op: 'cover', image: 'i1' }, { op: 'remove', images: ['i2'] }];
    expect(sendableBatch(ops)).toBe(ops);
    const cleared: MoodboardOp[] = [{ op: 'cover', image: 'i2' }, { op: 'remove', images: ['i2'] }, { op: 'cover', image: null }];
    expect(sendableBatch(cleared)).toBe(cleared);
    const removeOnly: MoodboardOp[] = [{ op: 'remove', images: ['i2'] }];
    expect(sendableBatch(removeOnly)).toBe(removeOnly);
  });
});
