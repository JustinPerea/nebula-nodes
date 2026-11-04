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
