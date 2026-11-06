import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { ReactFlowProvider, useStoreApi } from '@xyflow/react';
import {
  CARD_WIDTH_SPRING_ATTR, LAYOUT_SPRING_EASING, LAYOUT_SPRING_MS, NodeRemeasureContext, useCardWidthSpring,
  useFlowNodeRemeasure, useNodeRemeasure,
} from '../../src/lib/cardWidthSpring';

/**
 * GM r107 (#226): a card whose width changes from its own content (an Image
 * Input's preview landing) springs to its new width on the layout spring, the
 * same spring and timing as the Inspector's facing edge and height. A move,
 * pan or zoom never changes its layout width, so they stay rigid; reduced
 * motion jumps.
 *
 * jsdom has no layout, no ResizeObserver and no Web Animations: the observer
 * is driven by hand with the card's layout width, and `animate` records what
 * it is asked to play.
 */

type Observed = { callback: ResizeObserverCallback; target: Element | null };
let observers: Observed[];
let played: Array<{ keyframes: Keyframe[]; options: KeyframeAnimationOptions; animation: FakeAnimation }>;
let reduced: boolean;

class FakeAnimation extends EventTarget {
  cancelled = false;
  finish() { this.dispatchEvent(new Event('finish')); }
  cancel() { this.cancelled = true; this.dispatchEvent(new Event('cancel')); }
}

function Card({ onStart }: { onStart?: (card: HTMLElement) => void }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useCardWidthSpring(ref, onStart);
  return <div className="model-node__card" ref={ref} />;
}

const card = () => document.querySelector<HTMLDivElement>('.model-node__card')!;

/** What Canvas.tsx does: inside React Flow's provider, it gives its nodes the remeasure. */
function OnCanvas({ children }: { children: ReactNode }) {
  return <NodeRemeasureContext.Provider value={useFlowNodeRemeasure()}>{children}</NodeRemeasureContext.Provider>;
}
/** The observer reports the card's layout width (its border box). */
function laidOutAt(width: number) {
  act(() => {
    for (const o of observers) {
      o.callback([{ target: o.target!, borderBoxSize: [{ inlineSize: width, blockSize: 56 }] } as unknown as ResizeObserverEntry], {} as ResizeObserver);
    }
  });
}

beforeEach(() => {
  observers = [];
  played = [];
  reduced = false;
  vi.stubGlobal('ResizeObserver', class {
    entry: Observed;
    constructor(callback: ResizeObserverCallback) { this.entry = { callback, target: null }; observers.push(this.entry); }
    observe(target: Element) { this.entry.target = target; }
    unobserve() {}
    disconnect() { observers.splice(observers.indexOf(this.entry), 1); }
  });
  HTMLElement.prototype.animate = function (keyframes: Keyframe[], options: KeyframeAnimationOptions) {
    const animation = new FakeAnimation();
    played.push({ keyframes, options, animation });
    return animation as unknown as Animation;
  } as HTMLElement['animate'];
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: reduced && query.includes('reduce'), media: query }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete (HTMLElement.prototype as Partial<HTMLElement>).animate;
});

describe("a card's width springs when its own content widens it (GM r107)", () => {
  it('runs on the layout spring panels.css gives the Inspector, so the card and the panel move as one', () => {
    const css = readFileSync(resolve(__dirname, '../../src/styles/panels.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const [, given] = css.match(/--inspector-layout-spring:\s*([^;]+);/)!;
    expect(given.trim()).toBe(`${LAYOUT_SPRING_MS}ms ${LAYOUT_SPRING_EASING}`);
  });

  it('a preview landing (200 -> 240 px) springs from the old width to the new one, and is marked while it runs', () => {
    render(<Card />);
    laidOutAt(200);
    expect(played).toHaveLength(0);
    laidOutAt(240);
    expect(played).toHaveLength(1);
    expect(played[0].keyframes).toEqual([
      { boxSizing: 'border-box', width: '200px' }, { boxSizing: 'border-box', width: '240px' },
    ]);
    expect(played[0].options).toEqual({ duration: LAYOUT_SPRING_MS, easing: LAYOUT_SPRING_EASING });
    expect(card().hasAttribute(CARD_WIDTH_SPRING_ATTR)).toBe(true);
    // Its own frames while it springs start nothing more.
    laidOutAt(200);
    laidOutAt(213.6);
    expect(played).toHaveLength(1);
    act(() => played[0].animation.finish());
    expect(card().hasAttribute(CARD_WIDTH_SPRING_ATTR)).toBe(false);
    // At rest at 240: the observer's last report of it starts nothing.
    laidOutAt(240);
    expect(played).toHaveLength(1);
  });

  it('a later change springs from where it rested, and shrinking springs too', () => {
    render(<Card />);
    laidOutAt(200);
    laidOutAt(240);
    act(() => played[0].animation.finish());
    laidOutAt(220);
    expect(played).toHaveLength(2);
    expect(played[1].keyframes.map((k) => k.width)).toEqual(['240px', '220px']);
  });

  it('the first look at a card, and a sub-pixel change, start no spring', () => {
    render(<Card />);
    laidOutAt(236.6);
    laidOutAt(236.9);
    expect(played).toHaveLength(0);
    expect(card().hasAttribute(CARD_WIDTH_SPRING_ATTR)).toBe(false);
  });

  it('reduced motion: the card jumps, unmarked', () => {
    reduced = true;
    render(<Card />);
    laidOutAt(200);
    laidOutAt(240);
    expect(played).toHaveLength(0);
    expect(card().hasAttribute(CARD_WIDTH_SPRING_ATTR)).toBe(false);
  });

  it('unmounting mid-spring ends it', () => {
    const { unmount } = render(<Card />);
    laidOutAt(200);
    laidOutAt(240);
    const element = card();
    unmount();
    expect(played[0].animation.cancelled).toBe(true);
    expect(element.hasAttribute(CARD_WIDTH_SPRING_ATTR)).toBe(false);
    expect(observers).toHaveLength(0);
  });

  it('tells its node as the spring starts, in the same callback, with the card', () => {
    const onStart = vi.fn((card: HTMLElement) => {
      // The spring is already on it, at its old width.
      expect(played).toHaveLength(1);
      expect(card.hasAttribute(CARD_WIDTH_SPRING_ATTR)).toBe(true);
    });
    render(<Card onStart={onStart} />);
    laidOutAt(200);
    expect(onStart).not.toHaveBeenCalled();
    laidOutAt(240);
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onStart).toHaveBeenCalledWith(card());
  });
});

describe('reduced motion keeps the width it saw (review 5 LOW-1)', () => {
  it('turned off after a jump, the next change springs from where the card was, not from a stale width', () => {
    reduced = true;
    render(<Card />);
    laidOutAt(200);
    laidOutAt(240);
    expect(played).toHaveLength(0);
    reduced = false;
    laidOutAt(220);
    expect(played).toHaveLength(1);
    expect(played[0].keyframes.map((k) => k.width)).toEqual(['240px', '220px']);
  });

  it('ending the spring clears the mark from the card, and unmounting a card that never sprang leaves none', () => {
    const { unmount } = render(<Card />);
    laidOutAt(200);
    laidOutAt(240);
    const element = card();
    act(() => played[0].animation.cancel());
    expect(element.hasAttribute(CARD_WIDTH_SPRING_ATTR)).toBe(false);
    unmount();
    expect(element.hasAttribute(CARD_WIDTH_SPRING_ATTR)).toBe(false);
  });
});

/**
 * GM r114: every content width change springs, and one that lands while a
 * spring runs (typing a rename: a few px per keystroke) retargets it,
 * carrying on from the width and the speed the card has, never from rest.
 * The page is played a frame at a time: its card paints at its animation's
 * width (the keyframes, by offset; the layout spring's easing for the first
 * spring), and at its content's own width with the animation lifted
 * (effect.setKeyframes([]), which the hook uses to read it).
 */
describe('a content change while the spring runs retargets it, keeping its speed (GM r114)', () => {
  const FRAME = 1000 / 60;
  const points = LAYOUT_SPRING_EASING.match(/linear\((.*)\)/)![1].split(',').map(Number);
  let now: number;
  let natural: number;
  let current: Fake | null;
  let all: Fake[];

  class Fake extends EventTarget {
    startAt: number | null = null;
    keyframes: Keyframe[];
    lifted = false;
    cancelled = false;
    finished = false;
    constructor(keyframes: Keyframe[], readonly options: KeyframeAnimationOptions) { super(); this.keyframes = keyframes; }
    get currentTime() { return this.startAt === null ? 0 : now - this.startAt; }
    set startTime(value: number | null) { this.startAt = value; }
    get effect() {
      return {
        getKeyframes: () => this.keyframes,
        setKeyframes: (next: Keyframe[]) => { this.lifted = next.length === 0; if (next.length) this.keyframes = next; },
      };
    }
    finish() { this.finished = true; this.dispatchEvent(new Event('finish')); }
    cancel() { this.cancelled = true; this.dispatchEvent(new Event('cancel')); }
    width(): number {
      const frames = this.keyframes;
      const elapsed = this.currentTime;
      const duration = Number(this.options.duration);
      const share = Math.min(1, Math.max(0, elapsed / duration));
      if (frames.length === 2) {
        const at = share * (points.length - 1);
        const i = Math.min(points.length - 2, Math.floor(at));
        const curve = points[i] + (points[i + 1] - points[i]) * (at - i);
        const from = parseFloat(String(frames[0].width));
        return from + (parseFloat(String(frames[1].width)) - from) * curve;
      }
      const i = Math.min(frames.length - 2, Math.floor(share * (frames.length - 1)));
      const a = parseFloat(String(frames[i].width));
      const b = parseFloat(String(frames[i + 1].width));
      return a + (b - a) * (share * (frames.length - 1) - i);
    }
  }

  /** What the page paints for the card: the animation's width, or its content's. */
  const painted = () => (current && !current.cancelled && !current.finished && !current.lifted ? current.width() : natural);

  /** One frame: time moves, a pending animation starts, one at its end finishes, the observer reports. */
  function frame() {
    now += FRAME;
    if (current && current.startAt === null) current.startAt = now;
    if (current && current.startAt !== null && now - current.startAt >= Number(current.options.duration)) {
      const done = current;
      act(() => done.finish());
      current = null;
    }
    let reported = NaN;
    for (let i = 0; i < 4 && reported !== painted(); i++) {
      reported = painted();
      laidOutAt(reported);
    }
    return painted();
  }

  beforeEach(() => {
    now = 0;
    natural = 200;
    current = null;
    all = [];
    vi.stubGlobal('document', Object.assign(document, {}));
    Object.defineProperty(document, 'timeline', { configurable: true, get: () => ({ currentTime: now }) });
    HTMLElement.prototype.animate = function (keyframes: Keyframe[], options: KeyframeAnimationOptions) {
      const animation = new Fake(keyframes, options);
      // A new animation only becomes the page's when it replaces the last.
      current = animation;
      all.push(animation);
      return animation as unknown as Animation;
    } as HTMLElement['animate'];
    HTMLElement.prototype.getBoundingClientRect = function () {
      return new DOMRect(0, 0, painted(), 56);
    };
  });

  afterEach(() => {
    delete (document as unknown as { timeline?: unknown }).timeline;
    delete (HTMLElement.prototype as Partial<HTMLElement>).getBoundingClientRect;
  });

  function settleAt(width: number) {
    natural = width;
    laidOutAt(width);
  }

  /** Types: each of `steps` frames the content grows `grow` px, after `lead` frames of the first spring. */
  function type(lead: number, steps: number, grow: number) {
    render(<Card />);
    settleAt(200);
    natural = 240;
    const widths = [frame()];
    for (let i = 0; i < lead; i++) widths.push(frame());
    for (let i = 0; i < steps; i++) {
      natural += grow;
      widths.push(frame());
    }
    for (let i = 0; i < 80; i++) widths.push(frame());
    return widths;
  }

  it('retargets each keystroke: one spring at a time, the card marked throughout, ending at the last width, unmarked', () => {
    render(<Card />);
    settleAt(200);
    natural = 240;
    frame();
    for (let i = 0; i < 4; i++) frame();
    expect(card().hasAttribute(CARD_WIDTH_SPRING_ATTR)).toBe(true);
    const first = all.length;
    for (let i = 0; i < 5; i++) {
      natural += 3;
      frame();
      expect(card().hasAttribute(CARD_WIDTH_SPRING_ATTR)).toBe(true);
    }
    // One new spring per change, each cancelling the one before.
    expect(all.length - first).toBe(5);
    expect(all.slice(0, -1).every((a) => a.cancelled)).toBe(true);
    expect(all[all.length - 1].cancelled).toBe(false);
    for (let i = 0; i < 80; i++) frame();
    expect(painted()).toBe(255);
    expect(card().hasAttribute(CARD_WIDTH_SPRING_ATTR)).toBe(false);
    expect(all[all.length - 1].finished).toBe(true);
  });

  it('keeps its speed across a retarget, never restarting from rest: a change a frame apart, six in a row', () => {
    const widths = type(5, 6, 3);
    const step = widths.map((w, i) => (i ? w - widths[i - 1] : 0));
    // The change lands in frame 7 of the run (6 + lead); from there on, the
    // step between frames changes only as far as the spring's pull does
    // (omega^2 x distance x dt^2, about 4 px a frame at 40 px), never down to
    // the ~2 px step a spring starting from rest takes.
    const dt = FRAME / 1000;
    for (let i = 7; i < 14; i++) {
      const distance = Math.abs(258 - widths[i]);
      expect(Math.abs(step[i] - step[i - 1])).toBeLessThanOrEqual(19.65 ** 2 * (distance + 3) * dt * dt + 0.6);
      // Moving on, in the direction of its target (no stall frame, no restart).
      expect(step[i]).toBeGreaterThan(0.5);
    }
    // And it settles at the last width.
    expect(widths[widths.length - 1]).toBe(258);
  });

  it('a retarget at speed carries it: the step after the change is as big as before it, not a start from rest', () => {
    const widths = type(5, 1, 20);
    const before = widths[5] - widths[4];
    const after = widths[7] - widths[6];
    expect(before).toBeGreaterThan(4);
    // From rest, the first steps toward a target 20 px further would be ~2 px.
    expect(after).toBeGreaterThan(before * 0.8);
  });

  it('a change back to the width it came from springs back, and ends there', () => {
    render(<Card />);
    settleAt(200);
    natural = 240;
    for (let i = 0; i < 6; i++) frame();
    natural = 200;
    for (let i = 0; i < 90; i++) frame();
    expect(painted()).toBe(200);
    expect(card().hasAttribute(CARD_WIDTH_SPRING_ATTR)).toBe(false);
  });

  it('a content width within half a pixel of the target starts nothing', () => {
    render(<Card />);
    settleAt(200);
    natural = 240;
    for (let i = 0; i < 6; i++) frame();
    const count = all.length;
    natural = 240.3;
    for (let i = 0; i < 4; i++) frame();
    expect(all.length).toBe(count);
  });

  it('reduced motion jumps, whatever the change', () => {
    reduced = true;
    render(<Card />);
    settleAt(200);
    natural = 240;
    frame();
    natural = 260;
    frame();
    expect(all).toHaveLength(0);
    expect(painted()).toBe(260);
  });

  it('a card whose animation cannot be lifted (no effect) keeps the spring it has', () => {
    render(<Card />);
    settleAt(200);
    natural = 240;
    frame();
    const spring = current!;
    Object.defineProperty(spring, 'effect', { value: null });
    natural = 260;
    for (let i = 0; i < 4; i++) frame();
    expect(all).toHaveLength(1);
  });
});

describe('React Flow measures the node again as the spring starts (GM r107: the wire never shows the new width for a frame)', () => {
  it('measures its node at once, forced, from the card\'s React Flow node', () => {
    const measured: Array<Map<string, { id: string; nodeElement: HTMLDivElement; force?: boolean }>> = [];
    let remeasure: ((card: HTMLElement) => void) | null = null;
    function Probe() {
      const store = useStoreApi();
      const fn = useNodeRemeasure('n1');
      useEffect(() => {
        store.setState({ updateNodeInternals: (updates) => { measured.push(updates as never); } });
        remeasure = fn;
      }, [store, fn]);
      return (
        <div className="react-flow__node" data-id="n1">
          <div className="model-node"><div className="model-node__card" /></div>
        </div>
      );
    }
    render(<ReactFlowProvider><OnCanvas><Probe /></OnCanvas></ReactFlowProvider>);
    act(() => remeasure!(card()));
    expect(measured).toHaveLength(1);
    const update = measured[0].get('n1')!;
    expect(update.id).toBe('n1');
    expect(update.force).toBe(true);
    expect(update.nodeElement).toBe(document.querySelector('.react-flow__node'));
  });

  it('a card outside a React Flow node measures nothing', () => {
    const measured: unknown[] = [];
    let remeasure: ((card: HTMLElement) => void) | null = null;
    function Probe() {
      const store = useStoreApi();
      const fn = useNodeRemeasure('n1');
      useEffect(() => {
        store.setState({ updateNodeInternals: (updates) => { measured.push(updates); } });
        remeasure = fn;
      }, [store, fn]);
      return <div className="model-node__card" />;
    }
    render(<ReactFlowProvider><OnCanvas><Probe /></OnCanvas></ReactFlowProvider>);
    act(() => remeasure!(card()));
    expect(measured).toHaveLength(0);
  });

  it('a card drawn outside a React Flow canvas renders, and its spring measures nothing', () => {
    let remeasure: ((card: HTMLElement) => void) | null = null;
    function Probe() {
      const fn = useNodeRemeasure('n1');
      useEffect(() => { remeasure = fn; }, [fn]);
      return <div className="model-node__card" />;
    }
    expect(() => render(<Probe />)).not.toThrow();
    const node = document.createElement('div');
    node.className = 'react-flow__node';
    const inNode = document.createElement('div');
    node.append(inNode);
    document.body.append(node);
    expect(() => act(() => remeasure!(inNode))).not.toThrow();
    node.remove();
  });
});
