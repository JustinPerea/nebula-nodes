/**
 * The arrange path while a card's chunk is not in: an agent edit's layout
 * (ArrangeController) waits for its new nodes to be drawn as their real cards
 * and measured, so it never lays out by a node's absence (a whole graph held
 * back) or by a fallback frame's size (a node added to a graph already shown).
 * At its deadline it lays out with what is drawn, the frame's size included,
 * so a chunk that never comes cannot block an arrange for good. The real Canvas
 * and the real ArrangeController, with the Character chunk under the test's
 * control; completeArrange is a recorder. Fake timers drive the controller's
 * check interval and clock, so the waiting halves cannot pass by being slow.
 */
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Node } from '@xyflow/react';
import type { NodeData } from '../src/types';

// ---- chunks under the test's control ----------------------------------------

interface Load { resolve: (module: unknown) => void; reject: (error: Error) => void }
const chunkLoads = vi.hoisted(() => ({ character: [] as Load[], jev: [] as Load[], renew: (() => {}) as () => void }));
const fitView = vi.hoisted(() => vi.fn(async () => true));
const arranged = vi.hoisted(() => ({
  calls: [] as Array<{ id: string; drawn: (string | null)[]; frames: number }>,
  sizes: [] as Array<Record<string, [number | undefined, number | undefined]>>,
}));

vi.mock('../src/store/graphStore', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/store/graphStore')>(),
  completeArrange: vi.fn(async (id: string) => {
    arranged.calls.push({
      id,
      drawn: [...document.querySelectorAll('.react-flow__node')].map((element) => element.getAttribute('data-id')),
      frames: document.querySelectorAll('[data-card-fallback=""]').length,
    });
    return 'arranged';
  }),
}));
// The sizes the layout was given.
vi.mock('../src/lib/arrangeEdit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/arrangeEdit')>();
  return {
    ...actual,
    arrangeNewNodes: ((request, all, edges, bounds) => {
      arranged.sizes.push(Object.fromEntries(all.map((node) => [node.id, [node.width, node.height]])));
      return actual.arrangeNewNodes(request, all, edges, bounds);
    }) as typeof actual.arrangeNewNodes,
  };
});

// Each chunk is a stand-in that delegates to a fresh lazyWithPreload per test
// (a chunk that has loaded stays loaded), whose load is a promise the test settles.
vi.mock('../src/lib/deferredChunks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/deferredChunks')>();
  const { lazyWithPreload } = await import('../src/lib/lazyWithPreload');
  const { createElement } = await import('react');
  function controlled(loads: Load[], pick: string) {
    let current = lazyWithPreload(() => new Promise<Record<string, never>>((resolve, reject) => {
      loads.push({ resolve: resolve as Load['resolve'], reject });
    }), (module) => module[pick]);
    const renew = () => {
      current = lazyWithPreload(() => new Promise<Record<string, never>>((resolve, reject) => {
        loads.push({ resolve: resolve as Load['resolve'], reject });
      }), (module) => module[pick]);
    };
    const stand = Object.assign((props: object) => createElement(current as never, props), {
      preload: () => current.preload(),
      retry: (trigger: Parameters<typeof current.retry>[0]) => current.retry(trigger),
      isLoaded: () => current.isLoaded(),
      isSettled: () => current.isSettled(),
      onSettle: (listener: () => void) => current.onSettle(listener),
      failures: () => current.failures(),
      subscribe: (listener: () => void) => current.subscribe(listener),
    });
    return { stand, renew };
  }
  const character = controlled(chunkLoads.character, 'CharacterNode');
  const jev = controlled(chunkLoads.jev, 'JevResultView');
  chunkLoads.renew = () => { character.renew(); jev.renew(); };
  return { ...actual, DeferredCharacterNode: character.stand, DeferredJevResultView: jev.stand };
});

vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), disconnect: vi.fn(), send: vi.fn(), subscribe: vi.fn(() => () => {}) } }));
vi.mock('../src/lib/agentRoster', async (original) => ({
  ...await original<typeof import('../src/lib/agentRoster')>(),
  fetchAgentRoster: () => new Promise(() => {}),
}));
vi.mock('@xyflow/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xyflow/react')>();
  return { ...actual, useReactFlow: () => ({ ...actual.useReactFlow(), fitView }) };
});
vi.mock('../src/components/SelectionToolbar', () => ({ SelectionToolbar: () => null }));
vi.mock('../src/components/CanvasNavigation', () => ({ CanvasNavigation: () => null }));
vi.mock('../src/components/canvas/CanvasViewReporter', () => ({ CanvasViewReporter: () => null }));
vi.mock('../src/components/canvas/AgentCursorLayer', () => ({ AgentCursorLayer: () => null }));
vi.mock('../src/components/canvas/PinLayer', () => ({ PinLayer: () => null }));
vi.mock('../src/components/canvas/PinComposer', () => ({ PinComposer: () => null }));
vi.mock('../src/components/canvas/ProposalLayer', () => ({ ProposalLayer: () => null }));
vi.mock('../src/components/canvas/ProposalBar', () => ({ ProposalBar: () => null }));
vi.mock('../src/components/ContextMenu', () => ({ ContextMenu: () => null }));
vi.mock('../src/store/canvasPinsStore', () => ({ useCanvasPinsStore: { getState: () => ({ pins: [] }) } }));
vi.mock('../src/components/ConnectionPopup', () => ({ ConnectionPopup: () => null }));
vi.mock('../src/lib/canvasSelection', () => ({
  selectedNodeIds: (nodes: Node<NodeData>[]) => nodes.filter((node) => node.selected).map((node) => node.id),
  publishCanvasSelection: vi.fn().mockResolvedValue(undefined),
}));

import { ReactFlowProvider } from '@xyflow/react';
import { Canvas } from '../src/components/Canvas';
import { useGraphStore } from '../src/store/graphStore';
import { useArrangeStore, selectMeasuring } from '../src/store/arrangeStore';
import { DeferredArrangeController } from '../src/lib/deferredChunks';
import { useUIStore } from '../src/store/uiStore';
import { useStoredAssetsStore } from '../src/store/storedAssetsStore';

// React Flow measures a node when its ResizeObserver reports it; jsdom has no
// layout, so a card reports 100 x 60 and a fallback frame 230 x 210 (a size
// that differs from the card's, as a frame's does).
const FRAME_SIZE = { width: 230, height: 210 };
class MeasuringObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe(target: Element) {
    queueMicrotask(() => {
      const frame = target.querySelector('[data-card-fallback=""]') !== null;
      const rect = frame ? FRAME_SIZE : { width: 100, height: 60 };
      this.callback([{ target, contentRect: rect } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
    });
  }
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = MeasuringObserver as unknown as typeof ResizeObserver;
(globalThis as unknown as { DOMMatrixReadOnly: unknown }).DOMMatrixReadOnly = class { m22 = 1; };
const isFrame = (element: HTMLElement) => element.querySelector('[data-card-fallback=""]') !== null;
Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get(this: HTMLElement) { return isFrame(this) ? FRAME_SIZE.width : 100; } });
Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get(this: HTMLElement) { return isFrame(this) ? FRAME_SIZE.height : 60; } });
// jsdom never loads an image; the controller waits for them to have loaded.
Object.defineProperty(HTMLImageElement.prototype, 'complete', { configurable: true, get: () => true });


function node(id: string, definitionId: string, type: string, patch: Partial<NodeData> = {}): Node<NodeData> {
  return { id, type, position: { x: Number(id.replace(/\D/g, '')) * 300, y: 0 },
    data: { definitionId, label: id, params: {}, state: 'idle', outputs: {}, ...patch } as NodeData };
}
const domNodes = () => [...document.querySelectorAll('.react-flow__node')].map((element) => element.getAttribute('data-id'));
const FAKE = { toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] } as const;
/** Moves the fake clock, with the promises that settle along the way. */
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const frames = () => [...document.querySelectorAll('[data-card-fallback=""]')].map((el) => el.closest('.react-flow__node')?.getAttribute('data-id'));
async function settle(): Promise<void> { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); }
const initialGraph = useGraphStore.getState();
const initialUI = useUIStore.getState();

beforeAll(async () => { await DeferredArrangeController.preload(); });
beforeEach(() => {
  chunkLoads.renew();
  chunkLoads.character.length = 0;
  chunkLoads.jev.length = 0;
  arranged.calls.length = 0;
  arranged.sizes.length = 0;
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {},
    addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false }));
  useStoredAssetsStore.setState({ entries: { 'character:c1': { status: 'ready', summary: { id: 'c1', name: 'Mara', thumbnail: '/api/outputs/c1.png' } } } });
  useUIStore.setState({ skin: 'slava-restraint', viewMode: 'canvas', onboardingActive: false, selectedNodeId: null, canvasFocusRequest: null,
    canvasViewport: { x: 0, y: 0, zoom: 1 }, canvasPerfMode: false });
  useGraphStore.setState({ nodes: [], edges: [], isExecuting: false, undoStack: [], redoStack: [] });
  useArrangeStore.setState({ pending: [], finished: [] });
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
  useGraphStore.setState(initialGraph, true);
  useUIStore.setState(initialUI, true);
  useArrangeStore.setState({ pending: [], finished: [] });
  vi.unstubAllGlobals();
});

const mount = () => render(<ReactFlowProvider><div style={{ width: 1200, height: 800 }}><Canvas /></div></ReactFlowProvider>);
const request = (nodeIds: string[]) => [{ id: 'a_1', nodeIds, direction: 'right' as const, gap: 120 }];
const loadCharacter = async () => {
  chunkLoads.character[0].resolve(await import('../src/components/nodes/CharacterNode'));
  await settle();
};

describe('an agent edit whose new node the hold keeps back', () => {
  it('is laid out only once the node is drawn and measured', async () => {
    vi.useFakeTimers(FAKE);
    mount();
    act(() => useGraphStore.getState().loadGraph(
      [node('n1', 'text-input', 'model-node', { params: { value: 'a cat' } }), node('n2', 'character', 'characterNode', { params: { character: 'c1' } })], []));
    act(() => useArrangeStore.getState().setPending(request(['n2'])));
    await settle();
    expect(domNodes()).toEqual([]);
    expect(selectMeasuring(useArrangeStore.getState())).toBe(true);

    // Well past the settle time (300 ms) and the check interval (150 ms): still waiting.
    await advance(900);
    expect(arranged.calls).toEqual([]);
    expect(useArrangeStore.getState().finished).toEqual([]);

    await loadCharacter();
    expect(domNodes().sort()).toEqual(['n1', 'n2']);
    // A check before the sizes have held for 300 ms does not arrange yet.
    await advance(150);
    expect(arranged.calls).toEqual([]);
    await advance(1000);
    expect(useArrangeStore.getState().finished).toEqual(['a_1']);
    // It ran with the node on screen as its card, never before.
    expect(arranged.calls.length).toBeGreaterThan(0);
    for (const call of arranged.calls) {
      expect(call.drawn.sort()).toEqual(['n1', 'n2']);
      expect(call.frames).toBe(0);
    }
    expect(selectMeasuring(useArrangeStore.getState())).toBe(false);
  });
});

describe('an agent edit whose new node is drawn as a fallback frame first', () => {
  const shownGraph = () => {
    mount();
    act(() => useGraphStore.getState().loadGraph([node('n1', 'text-input', 'model-node', { params: { value: 'a cat' } })], []));
  };
  const addCharacter = () => act(() => useGraphStore.setState((state) => ({
    nodes: [...state.nodes, node('n2', 'character', 'characterNode', { params: { character: 'c1' } })],
  })));

  it('waits for the real card, then lays out by the card\'s size and never the frame\'s', async () => {
    vi.useFakeTimers(FAKE);
    shownGraph();
    await settle();
    addCharacter();
    act(() => useArrangeStore.getState().setPending(request(['n2'])));
    await settle();
    // On screen at once as a frame, measured at the frame's size.
    expect(frames()).toEqual(['n2']);
    const stored = useGraphStore.getState().nodes.find((n) => n.id === 'n2');
    expect(stored?.measured).toMatchObject(FRAME_SIZE);

    // Past the settle time and many check intervals: the frame's size is not a size to lay out by.
    await advance(5000);
    expect(arranged.calls).toEqual([]);
    expect(arranged.sizes).toEqual([]);
    expect(useArrangeStore.getState().finished).toEqual([]);

    await loadCharacter();
    expect(frames()).toEqual([]);
    await advance(2000);
    expect(useArrangeStore.getState().finished).toEqual(['a_1']);
    expect(arranged.calls.length).toBeGreaterThan(0);
    for (const call of arranged.calls) expect(call.frames).toBe(0);
    for (const sizes of arranged.sizes) expect(sizes.n2).toEqual([100, 60]);
  });

  it('a chunk that never comes does not block the arrange for good: at the deadline it lays out with the frame\'s size', async () => {
    vi.useFakeTimers(FAKE);
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    shownGraph();
    await settle();
    addCharacter();
    act(() => useArrangeStore.getState().setPending(request(['n2'])));
    await settle();
    await act(async () => { for (const load of chunkLoads.character) load.reject(new Error('offline')); await Promise.resolve(); });
    await settle();
    await act(async () => { for (const load of chunkLoads.character) load.reject(new Error('offline')); await Promise.resolve(); });
    expect(frames()).toEqual(['n2']);

    await advance(14000);
    expect(arranged.calls).toEqual([]);
    await advance(1500);
    expect(useArrangeStore.getState().finished).toEqual(['a_1']);
    expect(arranged.calls.length).toBeGreaterThan(0);
    expect(arranged.sizes.at(-1)?.n2).toEqual([FRAME_SIZE.width, FRAME_SIZE.height]);
    quiet.mockRestore();
  });
});
