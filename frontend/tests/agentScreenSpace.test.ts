import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnchorResolver, type Box, type ResolverEnv } from '../src/lib/agentAnchorResolve';
import { domEvents, resolutionPoint, screenSpace, type ResizeObserverLike } from '../src/lib/agentCursorSpace';
import { outlineKind, outlineRings, type OutlineEntry } from '../src/lib/agentCursorOutlines';
import { AGENT_CURSOR_OUTLINE } from '../src/lib/agentCursorTuning';
import type { AgentCursorAnchor } from '../src/lib/wsClient';

/** Phase 3 slice 5: screenSpace (a CursorSpace over the DOM) and the outline rings. */

const VIEW: Box = { left: 0, top: 0, width: 1440, height: 900 };
const boxes = new Map<Element, Box>();
const env: ResolverEnv = {
  query: (selector) => Array.from(document.querySelectorAll(selector)),
  measure: (element) => boxes.get(element) ?? null,
  clip: () => VIEW,
};
const put = (attr: string, value: string, box: Box) => {
  const el = document.createElement('div');
  el.setAttribute(`data-agent-${attr}`, value);
  document.body.appendChild(el);
  boxes.set(el, box);
  return el;
};
const TILE: Box = { left: 100, top: 100, width: 120, height: 80 };
const image: AgentCursorAnchor = { surface: 'moodboard', itemId: 'b1/i1' };

function space(options: Partial<Parameters<typeof screenSpace>[0]> = {}) {
  let now = 0;
  return screenSpace({
    resolver: new AnchorResolver(env, () => (now += 1000)),
    measure: env.measure,
    pane: () => document.body,
    canvasMounted: () => false,
    gone: () => false,
    events: () => () => {},
    ...options,
  });
}

afterEach(() => {
  document.body.innerHTML = '';
  boxes.clear();
  vi.unstubAllGlobals();
});

describe('screenSpace', () => {
  it('is the window in client pixels at zoom 1', () => {
    const s = space();
    expect(s.zoom()).toBe(1);
    expect(s.viewKey()).toBe(s.viewKey());
    expect(s.fromClient({ x: 12, y: 34 }, new DOMRect())).toEqual({ x: 12, y: 34 });
    expect(s.snap({ x: 10.3, y: 20.6 }, new DOMRect(), 2)).toEqual({ x: 10.5, y: 20.5 });
    expect(s.nodeInfo('n1')).toBeUndefined();
    expect(s.labels().size).toBe(0);
    expect(s.wire).toBeUndefined();
  });

  it('resolves an anchor through the resolver to the item\'s aim point', () => {
    put('anchor', 'moodboard:b1/i1', TILE);
    expect(space().resolve(image)).toEqual({ x: 160, y: 124 });
  });

  it('resolves to null when nothing does, and when the caller says the item is gone', () => {
    expect(space().resolve(image)).toBeNull();
    put('launcher', 'moodboard:b1', { left: 500, top: 10, width: 100, height: 30 });
    expect(space().resolve(image)).toEqual({ x: 606, y: 25 });
    expect(space({ gone: () => true }).resolve(image)).toBeNull();
  });

  it('gives the edge park and the launcher park their point, and none and gone no point', () => {
    const element = document.createElement('div');
    const box = { left: 0, top: 0, width: 1, height: 1 };
    expect(resolutionPoint({ kind: 'launcher', step: 'board', point: { x: 1, y: 2 }, element, box })).toEqual({ x: 1, y: 2 });
    expect(resolutionPoint({ kind: 'none' })).toBeNull();
    expect(resolutionPoint({ kind: 'gone' })).toBeNull();
  });

  it('chainPoint is the point it just resolved', () => {
    put('anchor', 'moodboard:b1/i1', TILE);
    const s = space();
    const point = s.resolve(image);
    expect(s.chainPoint(image)).toEqual(point);
  });

  it('carried: the same element again is the item\'s own move; a new element, or the first read, is not', () => {
    const tile = put('anchor', 'moodboard:b1/i1', TILE);
    const s = space();
    s.resolve(image);
    expect(s.carried?.(image)).toBe(false);
    s.resolve(image);
    expect(s.carried?.(image)).toBe(true);
    boxes.set(tile, { ...TILE, top: 400 });
    s.resolve(image);
    expect(s.carried?.(image)).toBe(true);
    tile.remove();
    put('anchor', 'moodboard:b1/i1', TILE);
    s.refresh();
    s.resolve(image);
    expect(s.carried?.(image)).toBe(false);
  });

  it('carried is false across a change of step: the exact item to a launcher', () => {
    const tile = put('anchor', 'moodboard:b1/i1', TILE);
    put('launcher', 'moodboard:b1', { left: 500, top: 10, width: 100, height: 30 });
    const s = space();
    s.resolve(image);
    s.resolve(image);
    tile.remove();
    s.refresh();
    s.resolve(image);
    expect(s.carried?.(image)).toBe(false);
  });

  it('subscribes to the page\'s events once, for every listener, and lets go with the last', () => {
    const teardown = vi.fn();
    const events = vi.fn(() => teardown);
    const s = space({ events });
    const a = s.subscribe(() => {});
    const b = s.subscribe(() => {});
    expect(events).toHaveBeenCalledTimes(1);
    a();
    expect(teardown).not.toHaveBeenCalled();
    b();
    expect(teardown).toHaveBeenCalledTimes(1);
  });

  it('refresh wakes every listener and makes the resolver look again', () => {
    const tile = put('anchor', 'moodboard:b1/i1', TILE);
    const s = space();
    const woke = vi.fn();
    s.subscribe(woke);
    expect(s.resolve(image)).toEqual({ x: 160, y: 124 });
    tile.remove();
    s.refresh();
    expect(woke).toHaveBeenCalledTimes(1);
    expect(s.resolve(image)).toBeNull();
  });

  it('outlineOf is the visible box of the exact item, and null at a launcher or when not drawn', () => {
    put('anchor', 'moodboard:b1/i1', TILE);
    const s = space();
    s.resolve(image);
    expect(s.outlineOf(image)).toEqual(TILE);
    document.body.innerHTML = '';
    boxes.clear();
    put('launcher', 'moodboard:b1', { left: 500, top: 10, width: 100, height: 30 });
    s.refresh();
    s.resolve(image);
    expect(s.outlineOf(image)).toBeNull();
  });
});

describe('domEvents', () => {
  it('wakes on a scroll anywhere (capture) and a resize, once a frame, and lets go on teardown', () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb));
    vi.stubGlobal('cancelAnimationFrame', () => {});
    const notify = vi.fn();
    const observe = { current: null as ResizeObserverLike | null };
    const teardown = domEvents(notify, observe);
    const scroller = document.createElement('div');
    document.body.appendChild(scroller);
    scroller.dispatchEvent(new Event('scroll')); // scroll doesn't bubble: only capture sees it
    window.dispatchEvent(new Event('resize'));
    expect(frames).toHaveLength(1);
    frames.shift()!(0);
    expect(notify).toHaveBeenCalledTimes(1);
    teardown();
    window.dispatchEvent(new Event('resize'));
    expect(frames).toHaveLength(0);
  });

  it('wakes when an anchor or a launcher comes or goes, and not for any other node', async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb));
    vi.stubGlobal('cancelAnimationFrame', () => {});
    const teardown = domEvents(() => {}, { current: null });
    document.body.appendChild(document.createElement('div'));
    await Promise.resolve();
    expect(frames).toHaveLength(0);
    const wrap = document.createElement('div');
    wrap.innerHTML = '<span data-agent-anchor="moodboard:b1"></span>';
    document.body.appendChild(wrap);
    await Promise.resolve();
    expect(frames).toHaveLength(1);
    teardown();
  });
});

describe('outline rings (design section 5, GM 3)', () => {
  const entry = (key: string, arrivedAt: number, extra: Partial<OutlineEntry> = {}): OutlineEntry => ({
    key, item: 'i1', kind: 'solid', color: '#E8825A', arrivedAt, box: { left: 100, top: 100, width: 120, height: 80 }, ...extra,
  });

  it('type is solid, propose dashed, and nothing else outlines', () => {
    expect(outlineKind('type')).toBe('solid');
    expect(outlineKind('propose')).toBe('dashed');
    for (const action of ['move', 'look', 'think', 'click', 'drag', 'run', 'wait', 'error'] as const) {
      expect(outlineKind(action), action).toBeNull();
    }
  });

  it('one agent: the item\'s own box', () => {
    const [ring] = outlineRings([entry('a', 1)]);
    expect(ring.box).toEqual({ left: 100, top: 100, width: 120, height: 80 });
    expect(ring.more).toBe(0);
  });

  it('two agents nest 2 px apart, the earliest innermost, on every side', () => {
    expect(AGENT_CURSOR_OUTLINE.stepPx).toBe(2);
    const rings = outlineRings([entry('late', 5), entry('early', 1)]);
    const inner = rings.find((r) => r.key === 'early')!;
    const outer = rings.find((r) => r.key === 'late')!;
    expect(inner.index).toBe(0);
    expect(outer.index).toBe(1);
    expect(outer.box).toEqual({ left: 98, top: 98, width: 124, height: 84 });
    expect(inner.box.left - outer.box.left).toBe(2);
  });

  it('from three, the outermost carries +N and no more rings are drawn', () => {
    const rings = outlineRings([entry('a', 1), entry('b', 2), entry('c', 3), entry('d', 4)]);
    expect(rings).toHaveLength(2);
    expect(rings.map((r) => r.more)).toEqual([0, 2]);
    expect(outlineRings([entry('a', 1), entry('b', 2), entry('c', 3)]).map((r) => r.more)).toEqual([0, 1]);
  });

  it('breaks an arrival tie by key, the same in every tab, and keeps items apart', () => {
    const rings = outlineRings([entry('b', 1), entry('a', 1), entry('z', 1, { item: 'i2' })]);
    expect(rings.find((r) => r.key === 'a')!.index).toBe(0);
    expect(rings.find((r) => r.key === 'b')!.index).toBe(1);
    expect(rings.find((r) => r.key === 'z')!.index).toBe(0);
  });
});
