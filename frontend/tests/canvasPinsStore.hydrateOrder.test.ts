// PR #218 review 1 MEDIUM-1: a hydrate's listing never overwrites a newer
// push. Hydrates and pushes share one order (a push's place is its arrival, a
// hydrate's is its fetch starting); a listing overtaken by a later one is
// dropped. Every case runs twice, with the Unicode chunk still pending
// (both listings wait on it) and with it already loaded.
import { afterEach, describe, expect, it, vi } from 'vitest';

const ctl = vi.hoisted(() => ({ fetches: [] as Array<(listing: unknown) => void> }));
vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: () => {}, subscribe: () => () => {}, send: () => {}, disconnect: () => {} } }));

const pin = (id: string) => ({ id, text: `${id} ❤️`, anchor: { x: 0, y: 0 }, status: 'open', createdAt: '' });
const listing = (projectId: string, ...ids: string[]) => ({ projectId, pins: ids.map(pin) });
const ticks = async () => { for (let i = 0; i < 5; i += 1) await new Promise((done) => setTimeout(done, 0)); };

type Mode = 'pending' | 'loaded';
/** A fresh canvasPins and store, the chunk held (pending) or let through (loaded). */
async function fresh(mode: Mode) {
  vi.resetModules();
  ctl.fetches = [];
  let release!: () => void;
  const gate = mode === 'pending' ? new Promise<void>((done) => { release = done; }) : Promise.resolve();
  // Registered again for each fresh module set: a module made by a vi.mock
  // factory outlives resetModules, so canvasPins (and its loaded chunk)
  // would carry over from the case before.
  vi.doMock('../src/lib/pinTextUnicode.json', async (importOriginal) => {
    await gate;
    return importOriginal();
  });
  vi.doMock('../src/lib/canvasPins', async (importOriginal) => ({
    ...await importOriginal<typeof import('../src/lib/canvasPins')>(),
    fetchPins: vi.fn(() => new Promise((resolve) => { ctl.fetches.push(resolve); })),
  }));
  const lib = await import('../src/lib/canvasPins');
  const { useCanvasPinsStore } = await import('../src/store/canvasPinsStore');
  if (mode === 'loaded') await lib.pinTextReady;
  expect(lib.pinTextIsLoaded()).toBe(mode === 'loaded');
  const store = useCanvasPinsStore;
  return {
    hydrate: () => store.getState().hydrate(),
    push: (event: ReturnType<typeof listing>) => store.getState().apply(event),
    answer: (index: number, event: ReturnType<typeof listing>) => ctl.fetches[index](event),
    ids: () => store.getState().pins.map((p) => p.id),
    project: () => store.getState().projectId,
    /** Let the chunk through (pending mode), then wait for every listing to land. */
    finish: async () => {
      if (mode === 'pending') release();
      await lib.pinTextReady;
      await ticks();
      expect(lib.pinTextIsLoaded()).toBe(true);
    },
  };
}

afterEach(() => { vi.resetModules(); });

describe.each<Mode>(['pending', 'loaded'])('hydrate and pushes in one order (chunk %s)', (mode) => {
  it('the review\'s probe: the fetch answers, then a newer push arrives; the push stays', async () => {
    const s = await fresh(mode);
    const h = s.hydrate();
    s.answer(0, listing('p', 'a'));
    await ticks();
    s.push(listing('p', 'a', 'b'));
    await s.finish();
    await h;
    expect(s.ids()).toEqual(['a', 'b']);
  });

  it('a push that arrives before the fetch answers: the older listing is dropped', async () => {
    const s = await fresh(mode);
    const h = s.hydrate();
    s.push(listing('p', 'a', 'b'));
    await ticks();
    s.answer(0, listing('p', 'a'));
    await s.finish();
    await h;
    expect(s.ids()).toEqual(['a', 'b']);
  });

  it('two hydrates in a row (a project switch): the first answering last never replaces the second', async () => {
    const s = await fresh(mode);
    const first = s.hydrate();
    const second = s.hydrate();
    s.answer(1, listing('p2', 'c'));
    await ticks();
    s.answer(0, listing('p1', 'a'));
    await s.finish();
    await Promise.all([first, second]);
    expect(s.project()).toBe('p2');
    expect(s.ids()).toEqual(['c']);
  });

  it('nothing newer: a hydrate applies, and a push after it replaces it', async () => {
    const s = await fresh(mode);
    const h = s.hydrate();
    s.answer(0, listing('p', 'a'));
    await s.finish();
    await h;
    expect(s.ids()).toEqual(['a']);
    s.push(listing('p', 'a', 'b'));
    await ticks();
    expect(s.ids()).toEqual(['a', 'b']);
    // A later hydrate (a reconnect) is newer than that push.
    const again = s.hydrate();
    s.answer(1, listing('p', 'b'));
    await again;
    await ticks();
    expect(s.ids()).toEqual(['b']);
  });

  it('pushes alone apply in arrival order', async () => {
    const s = await fresh(mode);
    s.push(listing('p', 'a'));
    s.push(listing('p', 'a', 'b'));
    s.push(listing('p', 'b'));
    await s.finish();
    expect(s.ids()).toEqual(['b']);
  });
});
