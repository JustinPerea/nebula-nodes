import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnchorResolver, domEnv, type Box, type ResolverEnv } from '../src/lib/agentAnchorResolve';
import { domEvents, screenSpace, type ResizeObserverLike } from '../src/lib/agentCursorSpace';
import type { AgentCursorAnchor } from '../src/lib/wsClient';

/**
 * PR #233 review 1, M1 to M4: what the screen space remembers of a cursor's
 * last read (one per cursor, pruned), the outline's clip read afresh, and what
 * wakes a resting cursor when only its container moved.
 */
const VIEW: Box = { left: 0, top: 0, width: 1440, height: 900 };
let clip: Box = VIEW;
const boxes = new Map<Element, Box>();
const containers = new Map<Element, Element[]>();
const env: ResolverEnv = {
  query: (selector) => Array.from(document.querySelectorAll(selector)),
  measure: (element) => boxes.get(element) ?? null,
  clip: () => clip,
  watch: (element) => containers.get(element) ?? [],
};
const put = (value: string, box: Box) => {
  const el = document.createElement('div');
  el.setAttribute('data-agent-anchor', value);
  document.body.appendChild(el);
  boxes.set(el, box);
  return el;
};
const TILE: Box = { left: 100, top: 100, width: 120, height: 80 };
const at = (image: string): AgentCursorAnchor => ({ surface: 'moodboard', itemId: `b1/${image}` });

function rig() {
  let now = 0;
  const watched: Element[][] = [];
  let notify: () => void = () => {};
  const space = screenSpace({
    resolver: new AnchorResolver(env, () => (now += 1000)),
    measure: env.measure,
    watch: env.watch,
    pane: () => document.body,
    canvasMounted: () => false,
    gone: () => false,
    events: (wake, observe) => {
      notify = wake;
      observe.current = { watch: (elements) => { watched.push([...elements]); } };
      return () => {};
    },
  });
  space.subscribe(() => {});
  return { space, watched, last: () => watched[watched.length - 1] ?? [], wake: () => notify() };
}

afterEach(() => {
  document.body.innerHTML = '';
  boxes.clear();
  containers.clear();
  clip = VIEW;
  vi.unstubAllGlobals();
});

describe('M1: the last reads are pruned', () => {
  it('keeps one read a cursor: a cursor that moves to another item no longer holds or watches the first', () => {
    const a = put('moodboard:b1/i1', TILE);
    const b = put('moodboard:b1/i2', TILE);
    const { space, last } = rig();
    space.resolve(at('i1'), 'claude#a');
    expect(space.held()).toBe(1);
    expect(last()).toEqual([a]);
    space.resolve(at('i2'), 'claude#a');
    expect(space.held()).toBe(1);
    expect(last()).toEqual([b]);
  });

  it('drops a cursor\'s read when it is forgotten (its view went), so nothing is held or observed', () => {
    const a = put('moodboard:b1/i1', TILE);
    const { space, last } = rig();
    space.resolve(at('i1'), 'claude#a');
    space.resolve(at('i1'), 'claude#b');
    space.resolve(at('i1'), 'claude#b>from');
    expect(space.held()).toBe(3);
    space.forget!('claude#b');
    expect(space.held()).toBe(1);
    expect(last()).toEqual([a]);
    space.forget!('claude#a');
    expect(space.held()).toBe(0);
    expect(last()).toEqual([]);
  });

  it('lets go of an element that left the page, however the cursor stands', () => {
    const a = put('moodboard:b1/i1', TILE);
    const b = put('moodboard:b1/i2', TILE);
    const { space, last } = rig();
    space.resolve(at('i1'), 'claude#a');
    space.resolve(at('i2'), 'claude#b');
    a.remove();
    space.resolve(at('i2'), 'claude#b'); // b's next frame: a's detached element is not kept
    expect(space.held()).toBe(1);
    expect(last()).toEqual([b]);
  });

  it('many items worked through do not pile up: held stays the cursor count', () => {
    const { space } = rig();
    for (let n = 0; n < 40; n += 1) {
      const el = put(`moodboard:b1/m${n}`, TILE);
      space.resolve(at(`m${n}`), 'claude#a');
      el.remove();
    }
    expect(space.held()).toBeLessThanOrEqual(1);
  });
});

describe('M2: carried is each cursor\'s own', () => {
  it('two cursors resting on one item: when its element is replaced, both fly, neither rides', () => {
    const first = put('moodboard:b1/i1', TILE);
    const { space } = rig();
    for (const owner of ['claude#a', 'claude#b']) space.resolve(at('i1'), owner);
    // A repeat read of the same element is a ride for both.
    for (const owner of ['claude#a', 'claude#b']) space.resolve(at('i1'), owner);
    expect(space.carried!(at('i1'), 'claude#a')).toBe(true);
    expect(space.carried!(at('i1'), 'claude#b')).toBe(true);
    first.remove();
    put('moodboard:b1/i1', { left: 600, top: 400, width: 120, height: 80 });
    space.refresh();
    space.resolve(at('i1'), 'claude#a');
    space.resolve(at('i1'), 'claude#b');
    expect(space.carried!(at('i1'), 'claude#a')).toBe(false);
    expect(space.carried!(at('i1'), 'claude#b')).toBe(false); // used to read the first cursor's read, and ride
  });

  it('a cursor that changed target is not carried to it', () => {
    put('moodboard:b1/i1', TILE);
    put('moodboard:b1/i2', TILE);
    const { space } = rig();
    space.resolve(at('i1'), 'claude#a');
    space.resolve(at('i2'), 'claude#a');
    expect(space.carried!(at('i2'), 'claude#a')).toBe(false);
  });
});

describe('M3: the outline reads its clip afresh', () => {
  it('a container that shrank clips the outline now, before the cursor\'s own frame', () => {
    put('moodboard:b1/i1', TILE);
    const { space } = rig();
    space.resolve(at('i1'), 'claude#a');
    expect(space.outlineOf(at('i1'))).toEqual(TILE);
    clip = { left: 0, top: 0, width: 160, height: 900 }; // the panel narrowed; the item's size did not change
    space.refresh();
    expect(space.outlineOf(at('i1'))).toEqual({ left: 100, top: 100, width: 60, height: 80 });
  });
});

describe('M4: what wakes a resting cursor', () => {
  it('watches what can move the item (its container chain) as well as the item', () => {
    const tile = put('moodboard:b1/i1', TILE);
    const scroller = document.createElement('div');
    const list = document.createElement('div');
    document.body.append(scroller, list);
    containers.set(tile, [list, scroller]);
    const { space, last } = rig();
    space.resolve(at('i1'), 'claude#a');
    expect(new Set(last())).toEqual(new Set([tile, list, scroller]));
    space.forget!('claude#a');
    expect(last()).toEqual([]);
  });

  it('domEnv.watch gives the ancestors up to the outermost clipping one', () => {
    const outer = document.createElement('div');
    outer.style.overflowY = 'auto';
    const mid = document.createElement('div');
    const inner = document.createElement('section');
    inner.style.overflowY = 'hidden';
    const item = document.createElement('div');
    inner.appendChild(item);
    mid.appendChild(inner);
    outer.appendChild(mid);
    document.body.appendChild(outer);
    expect(domEnv().watch!(item)).toEqual([inner, mid, outer]);
    const plain = document.createElement('div');
    document.body.appendChild(plain);
    expect(domEnv().watch!(plain)).toEqual([]); // nothing clips it: nothing to watch
  });

  it('a transition or animation ending wakes it (a panel that slid), once a frame', () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb));
    vi.stubGlobal('cancelAnimationFrame', () => {});
    const notify = vi.fn();
    const teardown = domEvents(notify, { current: null as ResizeObserverLike | null });
    const dock = document.createElement('div');
    document.body.appendChild(dock);
    dock.dispatchEvent(new Event('transitionend'));
    expect(frames).toHaveLength(1);
    frames.shift()!(0);
    expect(notify).toHaveBeenCalledTimes(1);
    dock.dispatchEvent(new Event('animationend'));
    expect(frames).toHaveLength(1);
    frames.shift()!(0);
    expect(notify).toHaveBeenCalledTimes(2);
    teardown();
    dock.dispatchEvent(new Event('transitionend'));
    expect(frames).toHaveLength(0);
  });
});
